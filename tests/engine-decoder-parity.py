"""Keep timestamp-based reads equivalent to the original OpenCV seek path."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import cv2
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
os.environ["DUCKY_FFMPEG_PATH"]=str(ROOT/"node_modules"/"ffmpeg-static"/"ffmpeg.exe")
sys.path.insert(0,str(ROOT/"engine"))
from renderer import Source

FFMPEG=os.environ["DUCKY_FFMPEG_PATH"]
FFPROBE=str(ROOT/"node_modules"/"ffprobe-static"/"bin"/"win32"/"x64"/"ffprobe.exe")
FLAGS=subprocess.CREATE_NO_WINDOW if sys.platform=="win32" else 0


class DecoderParityTests(unittest.TestCase):
    def compare(self,name,options,times,trim=0,speed=1):
        with tempfile.TemporaryDirectory(prefix="ducky-decode-") as directory:
            file=str(Path(directory)/f"{name}.mp4")
            subprocess.run([FFMPEG,"-hide_banner","-loglevel","error","-y","-f","lavfi","-i","testsrc2=size=160x90:rate=30:duration=3",
                *options,"-c:v","libx264","-bf","0","-pix_fmt","yuv420p",file],check=True,creationflags=FLAGS)
            metadata=json.loads(subprocess.check_output([FFPROBE,"-v","error","-select_streams","v:0","-show_entries","stream=avg_frame_rate,r_frame_rate,start_time,duration","-of","json",file],creationflags=FLAGS))["streams"][0]
            clip={"in":trim,"speed":speed,"title":None}
            source=Source(clip,{"kind":"video","path":file,"name":name},{},160,90,3)
            legacy=cv2.VideoCapture(file)
            differences=[]
            try:
                for local in times:
                    legacy.set(cv2.CAP_PROP_POS_MSEC,(trim+local*speed)*1000)
                    ok,expected=legacy.read()
                    actual=source._read(local)
                    if not ok:continue
                    differences.append(float(np.abs(actual.astype(np.int16)-expected.astype(np.int16)).mean()))
            finally:
                source.close();legacy.release()
            print(name,metadata,"MAE",differences)
            self.assertLessEqual(max(differences,default=0),.01,f"Timestamp read drift in {name}: {differences}")

    def test_cfr_trim_speed(self):
        self.compare("cfr",[],[0,.1,.2,.4,.7,.9],trim=.3,speed=1.5)

    def test_vfr_changes_from_five_to_thirty_frames_per_second(self):
        self.compare("vfr",["-vf","select=if(lt(t\\,1)\\,not(mod(n\\,6))\\,1)","-fps_mode","vfr"],[0,.2,.4,.6,.8,1,1.2,1.6,2.4])

    def test_nonzero_stream_start_timestamp(self):
        self.compare("offset",["-vf","setpts=PTS+2/TB","-copyts"],[0,.2,.5,.8,1.2,1.6])


if __name__=="__main__":unittest.main()
