"""Native cache, seek, GPU/CPU parity and actual FFmpeg fallback regressions."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

import cv2
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"engine"))
os.environ.setdefault("DUCKY_FFMPEG_PATH",str(ROOT/"node_modules/ffmpeg-static/ffmpeg.exe"))
import renderer
from ducky import encoding


def clip(**changes):
    return {"id":"one","assetId":"image","in":0,"out":1,"speed":1,"volume":1,"muted":True,
        "fit":"contain","background":"blur","filter":"warm","brightness":.05,"contrast":1.1,"saturation":1.1,
        "title":{"text":"DuckyMovie","style":"lower","color":"#ffffff"},**changes}


class NativeEncodingTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory(prefix="ducky-encoder-")
        self.directory=Path(self.folder.name)
        y,x=np.mgrid[0:240,0:180]
        pixels=np.stack([x%256,y%256,(x+y)%256],axis=2).astype(np.uint8)
        self.image=self.directory/"image.png"
        Image.fromarray(pixels).save(self.image)
        self.asset={"id":"image","name":"image","kind":"image","path":str(self.image),"hasAudio":False}
        self.project={"aspectRatio":"16:9","clips":[clip()],"assets":[self.asset],"audioTracks":[]}

    def tearDown(self):
        self.folder.cleanup()

    def test_static_preparation_cached_but_zoom_fade_and_position_remain_dynamic(self):
        source=renderer.Source(clip(zoom="in",zoomAmount=1.2,fadeIn=.3,fadeOut=.3),self.asset,self.project,320,180,1)
        with mock.patch.object(source,"_prepare",wraps=source._prepare) as prepare:
            first,first_alpha=source.frame(.1)
            middle,middle_alpha=source.frame(.5)
            last,last_alpha=source.frame(.9)
            self.assertEqual(prepare.call_count,1)
            self.assertGreater(np.mean(np.abs(first.astype(float)-last)),2)
            self.assertGreater(float(middle_alpha.mean()),float(first_alpha.mean())*2)
            self.assertLess(abs(float(first_alpha.mean())-float(last_alpha.mean())),1e-5)
        source.close()
        fixed=renderer.Source(clip(fadeIn=.2),self.asset,self.project,320,180,1)
        pixels,alpha=fixed.frame(.1)
        copied=pixels.copy()
        pixels2,alpha2=fixed.frame(.5)
        self.assertTrue(np.array_equal(copied,pixels2))
        self.assertAlmostEqual(float(alpha2.mean()),float(alpha.mean())*2,places=5)
        fresh=renderer.Source(clip(fadeIn=.2),self.asset,self.project,320,180,1)
        independent=fresh.frame(.5)
        self.assertTrue(np.array_equal(pixels2,independent[0]))
        self.assertTrue(np.array_equal(alpha2,independent[1]))
        fixed.close();fresh.close()

    def test_sequential_video_decode_matches_independent_seeks_at_speed_and_after_jumps(self):
        video=self.directory/"moving.mp4"
        subprocess.run([encoding.FFMPEG_EXE,"-v","error","-y","-f","lavfi","-i","testsrc2=size=96x64:rate=24:duration=3",
            "-c:v","libx264","-g","48","-pix_fmt","yuv420p",str(video)],check=True)
        asset={**self.asset,"kind":"video","path":str(video)}
        reference=cv2.VideoCapture(str(video))
        for speed in (.5,1,1.5,2):
            settings=clip(**{"in":.13,"out":2.9,"speed":speed,"filter":"none","brightness":0,"contrast":1,"saturation":1,"title":None,"fit":"cover"})
            source=renderer.Source(settings,asset,self.project,96,64,2.77/speed)
            for position in (0,1/24,2/24,.13,.4,.04,1.1,.2,.2,.23):
                position=min(position,2.7/speed)
                reference.set(cv2.CAP_PROP_POS_MSEC,(.13+position*speed)*1000)
                ok,expected=reference.read()
                self.assertTrue(ok)
                actual,_=source.frame(position)
                self.assertTrue(np.array_equal(actual,expected),f"speed {speed}, position {position}")
            source.close()
        reference.release()

    def test_cpu_requested_never_probes_hardware(self):
        with mock.patch.object(encoding,"_probe_encoder",side_effect=AssertionError("CPU mode must not probe GPU")):
            choice=encoding.choose_encoding({"acceleration":"cpu"},{"encoder":"h264_nvenc"})
        self.assertEqual(choice.encoder,"libx264")

    def test_real_failed_hardware_initialization_restarts_once_on_cpu(self):
        args=encoding.encoder_args("h264_nvenc")+["-gpu","9999"]
        output=self.directory/"fallback.mp4"
        with mock.patch.object(renderer,"choose_encoding",return_value=encoding.EncodingChoice("h264_nvenc",args)):
            result=renderer.render_project(self.project,{"resolution":"720p","fps":24,"quality":"standard"},str(output),lambda *event:None,threading.Event())
        self.assertEqual(result["encoding"]["encoder"],"libx264")
        self.assertIn("fallback",result["encoding"])
        capture=cv2.VideoCapture(str(output))
        self.assertEqual(round(capture.get(cv2.CAP_PROP_FRAME_COUNT)),24)
        self.assertEqual(capture.get(cv2.CAP_PROP_FRAME_WIDTH),1280)
        capture.release()

    def test_media_filter_errors_and_cancellation_do_not_retry_cpu(self):
        settings={"resolution":"720p","fps":24,"quality":"standard"}
        for message,cancelled in (("No such filter: bad_filter",False),("h264_nvenc device lost",True)):
            cancel=threading.Event()
            if cancelled: cancel.set()
            with mock.patch.object(renderer,"choose_encoding",return_value=encoding.EncodingChoice("h264_nvenc",[])),mock.patch.object(renderer,"_render_video_once",side_effect=renderer.VideoEncodingFailure(message)) as once:
                with self.assertRaises(renderer.VideoEncodingFailure):
                    renderer._render_video(self.project,settings,{},[],1,self.directory/"bad.mp4",self.directory,lambda *event:None,cancel)
                self.assertEqual(once.call_count,1)

    def test_real_gpu_and_cpu_decoded_frames_preserve_effects_and_animation(self):
        choice=encoding.choose_encoding()
        if choice.encoder=="libx264": self.skipTest("No usable hardware encoder on this computer")
        project={**self.project,"clips":[clip(zoom="in",zoomAmount=1.12)],"overlays":[
            {"id":"label","kind":"text","start":.2,"end":.85,"text":"GPU test","x":.5,"y":.2,"width":.5,"opacity":1,"animation":"fade"}]}
        files=[]
        for acceleration in ("cpu","auto"):
            file=self.directory/(acceleration+".mp4")
            result=renderer.render_project(project,{"resolution":"720p","fps":24,"quality":"high","acceleration":acceleration},str(file),lambda *event:None,threading.Event())
            self.assertEqual(result["encoding"]["mode"],"cpu" if acceleration=="cpu" else "gpu")
            frames=subprocess.check_output([encoding.FFMPEG_EXE,"-v","error","-i",str(file),"-vf","fps=6,scale=320:180","-f","rawvideo","-pix_fmt","rgb24","pipe:1"])
            files.append(np.frombuffer(frames,np.uint8).reshape(-1,180,320,3).astype(np.float32))
        self.assertEqual(files[0].shape,files[1].shape)
        mse=float(np.mean((files[0]-files[1])**2))
        psnr=10*np.log10(255**2/max(1e-8,mse))
        self.assertGreater(psnr,32)
        self.assertGreater(np.mean(np.abs(files[1][0]-files[1][-1])),2,"Ken Burns must remain animated")
        print(f"CPU/{choice.encoder} decoded parity PSNR {psnr:.2f} dB")


if __name__=="__main__":
    unittest.main()
