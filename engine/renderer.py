"""Native DuckyMovie project compositor using the ported DuckyPlay primitives."""
import base64
import contextlib
import math
import os
from pathlib import Path
import subprocess
import tempfile
import threading

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

from ducky import videomake as vm
from ducky.config import FFMPEG_EXE
from ducky.ffmpeg_tools import CREATE_NO_WINDOW, FfmpegError, run_ffmpeg
from ducky.tempo import _atempo_chain
from ducky.encoding import choose_encoding, cpu_encoding, report_encoding, is_hardware_failure


def _dimensions(aspect, resolution):
    side = {"720p": 720, "1080p": 1080, "1440p": 1440, "2160p": 2160}[resolution]
    long_side = round(side * 16 / 9 / 2) * 2
    return (side, side) if aspect == "1:1" else ((side, long_side) if aspect == "9:16" else (long_side, side))


def _positions(project):
    cursors = {}
    positions = []
    default_video=next((track["id"] for track in project.get("tracks",[]) if track["kind"]=="video"),"video-main")
    for clip in project["clips"]:
        if not clip.get("trackId"):
            clip={**clip,"trackId":default_video}
        lane = clip.get("trackId", "video-main")
        cursor = cursors.get(lane, 0.0)
        start = float(clip.get("start", cursor))
        duration = (clip["out"] - clip["in"]) / clip["speed"]
        positions.append((clip, start, start + duration))
        cursors[lane] = max(cursor, start + duration)
    audio_end = max((audio["start"] + audio["out"] - audio["in"] for audio in project.get("audioTracks", [])), default=0)
    overlay_end=max((overlay["end"] for overlay in project.get("overlays",[])),default=0)
    return positions, max([float(project.get("duration") or 0), audio_end, overlay_end, *cursors.values()])


def _cover(frame, w, h):
    ih, iw = frame.shape[:2]
    scale = max(w / iw, h / ih)
    resized = cv2.resize(frame, (max(w, round(iw * scale)), max(h, round(ih * scale))), interpolation=cv2.INTER_LINEAR)
    y, x = (resized.shape[0] - h) // 2, (resized.shape[1] - w) // 2
    return resized[y:y+h, x:x+w].copy()


def _fit(frame, alpha, w, h, fit, background):
    if fit == "cover":
        return _cover(frame, w, h), _cover(alpha, w, h)
    if background == "blur":
        canvas = cv2.GaussianBlur(_cover(frame, w, h), (0, 0), min(w, h) * .018)
        canvas_alpha = np.ones((h,w),np.float32)
    else:
        canvas = np.zeros((h, w, 3), np.uint8)
        canvas_alpha = np.zeros((h,w),np.float32)
    ih, iw = frame.shape[:2]
    scale = min(w / iw, h / ih)
    rw, rh = max(1, round(iw * scale)), max(1, round(ih * scale))
    resized = cv2.resize(frame, (rw, rh), interpolation=cv2.INTER_LINEAR)
    resized_alpha = cv2.resize(alpha, (rw,rh), interpolation=cv2.INTER_LINEAR)
    x, y = (w-rw)//2, (h-rh)//2
    if background == "blur":
        region=canvas[y:y+rh,x:x+rw].astype(np.float32)
        canvas[y:y+rh,x:x+rw]=(region*(1-resized_alpha[:,:,None])+resized*resized_alpha[:,:,None]).astype(np.uint8)
    else:
        canvas[y:y+rh, x:x+rw] = resized
        canvas_alpha[y:y+rh,x:x+rw] = resized_alpha
    return canvas, canvas_alpha


def _saturation(amount):
    return np.array([[.213+.787*amount, .715-.715*amount, .072-.072*amount],
        [.213-.213*amount, .715+.285*amount, .072-.072*amount],
        [.213-.213*amount, .715-.715*amount, .072+.928*amount]], np.float32)


def _sepia(amount):
    return np.array([[1-.607*amount,.769*amount,.189*amount],
        [.349*amount,1-.314*amount,.168*amount], [.272*amount,.534*amount,1-.869*amount]], np.float32)


def _hue(degrees):
    c, s = math.cos(degrees*math.pi/180), math.sin(degrees*math.pi/180)
    return np.array([[.213+.787*c-.213*s,.715-.715*c-.715*s,.072-.072*c+.928*s],
        [.213-.213*c+.143*s,.715+.285*c+.140*s,.072-.072*c-.283*s],
        [.213-.213*c-.787*s,.715-.715*c+.715*s,.072+.928*c+.072*s]], np.float32)


def _grade(frame, clip):
    if clip.get("filter", "none") == "none" and not clip.get("warmth",0) and not clip.get("brightness",0) and clip.get("contrast",1)==1 and clip.get("saturation",1)==1:
        return frame
    rgb = frame[:, :, ::-1].astype(np.float32)
    warmth=clip.get("warmth",0)
    if warmth:
        rgb[:,:,0]=np.clip(rgb[:,:,0]*(1+.1*warmth),0,255)
        rgb[:,:,2]=np.clip(rgb[:,:,2]*(1-.1*warmth),0,255)
    preset = clip.get("filter", "none")
    matrices = {"warm": [_sepia(.22), _saturation(1.18)],
        "cool": [_sepia(.12), _hue(170), _saturation(.8)],
        "mono": [_saturation(0)], "vintage": [_sepia(.45), _saturation(.75)]}.get(preset, [])
    for matrix in matrices:
        cv2.transform(rgb,matrix,dst=rgb)
        np.clip(rgb,0,255,out=rgb)
    if preset == "vintage":
        rgb = np.clip((rgb-127.5)*1.08+127.5, 0, 255)
    if preset == "vivid":
        rgb = np.clip((rgb*1.03-127.5)*1.12+127.5,0,255)
        rgb = np.clip(cv2.transform(rgb,_saturation(1.35)),0,255)
    if preset == "bright":
        rgb = np.clip(cv2.transform(np.clip(rgb*1.15,0,255),_saturation(1.05)),0,255)
    # Keep the same float32 operation order while avoiding four full-frame
    # temporaries per grade. The default saturation is exactly the identity.
    np.multiply(rgb,1+clip.get("brightness",0),out=rgb)
    np.subtract(rgb,127.5,out=rgb)
    np.multiply(rgb,clip.get("contrast",1),out=rgb)
    np.add(rgb,127.5,out=rgb)
    np.clip(rgb,0,255,out=rgb)
    if clip.get("saturation",1)!=1:
        cv2.transform(rgb,_saturation(clip["saturation"]),dst=rgb)
        np.clip(rgb,0,255,out=rgb)
    return rgb[:, :, ::-1].astype(np.uint8)


def _wrapped(text, length):
    lines = []
    for line in text.split("\n"):
        if len(line) <= length:
            lines.append(line)
            continue
        current = ""
        for word in line.split():
            if current and len(current)+len(word)+1 > length:
                lines.append(current)
                current = ""
            while len(word) > length:
                if current:
                    lines.append(current)
                    current = ""
                lines.append(word[:length])
                word = word[length:]
            current += (" " if current else "") + word
        if current:
            lines.append(current)
    return "\n".join(lines)


def _title_image(title, w, h):
    image = Image.new("RGBA", (w,h), (0,0,0,0))
    draw = ImageDraw.Draw(image)
    style = title.get("style", "center")
    size = round(w * (.042 if style == "lower" else .062 if style == "cinema" else .058))
    fontfile = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "arialbd.ttf"
    try:
        font = ImageFont.truetype(str(fontfile), size)
    except OSError:
        font = vm._load_overlay_font(size)
    text = _wrapped(title.get("text", ""), 38 if style == "lower" else 26)
    box = draw.multiline_textbbox((0,0), text, font=font, spacing=round(size*.2))
    tw, th = box[2]-box[0], box[3]-box[1]
    x = w*.06 if style == "lower" else (w-tw)/2
    y = h-th-h*.10 if style == "lower" else (h-th)/2
    if style == "cinema":
        draw.rectangle((0,0,w,h*.10), fill="black")
        draw.rectangle((0,h*.90,w,h), fill="black")
    draw.multiline_text((x+2,y-box[1]+2),text,font=font,spacing=round(size*.2),fill=(0,0,0,180),align="center")
    draw.multiline_text((x,y-box[1]),text,font=font,spacing=round(size*.2),fill=title.get("color", "#ffffff"),align="left" if style=="lower" else "center")
    data = np.asarray(image).astype(np.float32)
    return data[:, :, [2,1,0]], data[:,:,3:4]/255


class Source:
    def __init__(self, clip, asset, project, w, h, duration):
        self.clip, self.project, self.w, self.h, self.duration = clip, project, w, h, duration
        self.static = None
        self.static_alpha = None
        if asset["kind"] == "image":
            with Image.open(asset["path"]) as image:
                rgba=np.asarray(ImageOps.exif_transpose(image).convert("RGBA"))
            self.static=rgba[:,:,[2,1,0]].copy()
            self.static_alpha=rgba[:,:,3].astype(np.float32)/255
        self.cap = None if self.static is not None else cv2.VideoCapture(asset["path"])
        if self.cap is not None and not self.cap.isOpened():
            raise ValueError(f"Impossibile leggere {asset['name']}")
        self.last = None
        self.last_index = -1
        self.next_index = 0
        self.source_fps = self.cap.get(cv2.CAP_PROP_FPS) if self.cap is not None else 0
        self.fitted = None
        self.fitted_opaque = False
        self.fixed = None
        self.position_cache = None
        self.title = _title_image(clip["title"],w,h) if clip.get("title",{} ) and clip["title"].get("text", "").strip() else None
        self.title_bounds = None
        if self.title:
            x,y,tw,th=cv2.boundingRect((self.title[1][:,:,0]>0).astype(np.uint8))
            self.title_bounds=(x,y,tw,th)
            self.title=(self.title[0][y:y+th,x:x+tw],self.title[1][y:y+th,x:x+tw])

    def _read(self, local):
        seconds=self.clip["in"]+local*self.clip["speed"]
        target=max(0,round(seconds*self.source_fps))
        if target==self.last_index and self.last is not None:
            return self.last
        if target<self.next_index or target-self.next_index>max(8,self.source_fps*3):
            self.cap.set(cv2.CAP_PROP_POS_MSEC,seconds*1000)
            self.next_index=target
        while self.next_index<target:
            if not self.cap.grab(): break
            self.next_index+=1
        ok,frame=self.cap.read()
        if not ok:
            return self.last if self.last is not None else np.zeros((self.h,self.w,3),np.uint8)
        self.last=frame
        self.last_index=target
        self.next_index=target+1
        return frame

    def _prepare(self,frame,alpha):
        clip, w, h = self.clip, self.w, self.h
        crop = clip.get("crop")
        if crop:
            fh,fw = frame.shape[:2]
            x,y = min(fw-1,round(crop["x"]*fw)),min(fh-1,round(crop["y"]*fh))
            right,bottom = max(x+1,min(fw,round((crop["x"]+crop["w"])*fw))),max(y+1,min(fh,round((crop["y"]+crop["h"])*fh)))
            frame=frame[y:bottom,x:right]
            alpha=alpha[y:bottom,x:right]
        rotation=clip.get("rotation",0)
        rotation_codes={90:cv2.ROTATE_90_CLOCKWISE,180:cv2.ROTATE_180,270:cv2.ROTATE_90_COUNTERCLOCKWISE}
        if rotation in rotation_codes:
            frame=cv2.rotate(frame,rotation_codes[rotation])
            alpha=cv2.rotate(alpha,rotation_codes[rotation])
        frame,alpha = _fit(frame,alpha,w,h,clip.get("fit","contain"),clip.get("background","black"))
        return frame,alpha

    def frame(self, position):
        clip,w,h=self.clip,self.w,self.h
        local=max(0,min(position,self.duration))
        if self.position_cache is not None and self.position_cache[0]==local:
            return self.position_cache[1:]
        fi,fo=clip.get("fadeIn",0),clip.get("fadeOut",0)
        opacity=max(0,min(1,local/fi if fi else 1,(self.duration-local)/fo if fo else 1))
        if self.fixed is not None:
            frame,alpha=self.fixed
            layer=(frame,alpha*opacity if opacity!=1 else alpha)
            self.position_cache=(local,*layer)
            return layer
        if self.static is not None:
            if self.fitted is None:
                self.fitted=self._prepare(self.static,self.static_alpha)
                self.fitted_opaque=bool(np.all(self.fitted[1]>=1))
            frame,alpha=self.fitted
        else:
            frame=self._read(local)
            frame,alpha=self._prepare(frame,np.ones(frame.shape[:2],np.float32))
        zoom=clip.get("zoom","none")
        if zoom != "none":
            amount=clip.get("zoomAmount",1.12)
            p=min(1,local/max(.001,self.duration))
            eased=p*p*(3-2*p)
            scale=1+(amount-1)*(eased if zoom=="in" else 1-eased)
            transform=cv2.getRotationMatrix2D((w/2,h/2),0,scale)
            frame=cv2.warpAffine(frame,transform,(w,h),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT)
            if not (self.static is not None and self.fitted_opaque and scale>=1):
                alpha=cv2.warpAffine(alpha,transform,(w,h),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT)
        frame=_grade(frame,clip)
        mirrored=bool(self.project.get("mirror")) ^ bool(clip.get("mirror"))
        if mirrored:
            original=frame
            original_alpha=alpha
            frame=cv2.flip(frame,1)
            alpha=cv2.flip(alpha,1)
            protected=self.project.get("protectedArea")
            if protected:
                x,y=round(protected["x"]*w),round(protected["y"]*h)
                rw,rh=max(1,round(protected["w"]*w)),max(1,round(protected["h"]*h))
                x,y=max(0,min(x,w-rw)),max(0,min(y,h-rh))
                mx=w-x-rw
                frame[y:y+rh,mx:mx+rw]=original[y:y+rh,mx:mx+rw]
                frame[y:y+rh,x:x+rw]=original[y:y+rh,x:x+rw]
                alpha[y:y+rh,mx:mx+rw]=original_alpha[y:y+rh,mx:mx+rw]
                alpha[y:y+rh,x:x+rw]=original_alpha[y:y+rh,x:x+rw]
        if self.title:
            x,y,tw,th=self.title_bounds
            frame=frame.copy()
            alpha=alpha.copy()
            frame[alpha<=1e-6]=0
            region=frame[y:y+th,x:x+tw]
            region_alpha=alpha[y:y+th,x:x+tw]
            title_alpha=self.title[1][:,:,0]
            combined_alpha=title_alpha+region_alpha*(1-title_alpha)
            premultiplied=self.title[0]*self.title[1]+region.astype(np.float32)*region_alpha[:,:,None]*(1-self.title[1])
            frame[y:y+th,x:x+tw]=np.divide(premultiplied,combined_alpha[:,:,None],out=np.zeros_like(premultiplied),where=combined_alpha[:,:,None]>1e-6).astype(np.uint8)
            alpha[y:y+th,x:x+tw]=combined_alpha
        placement=clip.get("placement") or {}
        scale=placement.get("scale",1)
        x,y=placement.get("x",.5),placement.get("y",.5)
        if scale!=1 or x!=.5 or y!=.5:
            transform=np.array([[scale,0,x*w-scale*w/2],[0,scale,y*h-scale*h/2]],np.float32)
            frame=cv2.warpAffine(frame,transform,(w,h),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT)
            alpha=cv2.warpAffine(alpha,transform,(w,h),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT)
        if placement.get("opacity",1)!=1:
            alpha=alpha*placement["opacity"]
        if self.static is not None and zoom=="none":
            self.fixed=(frame,alpha)
        layer=(frame,alpha*opacity if opacity!=1 else alpha)
        self.position_cache=(local,*layer)
        return layer

    def close(self):
        if self.cap is not None: self.cap.release()


def _caption_events(words,max_words):
    count=max(1,min(20,int(max_words) or 5))
    valid=sorted((word for word in words if word["text"].strip() and word["end"]>word["start"]),key=lambda word:word["start"])
    events=[]
    group=[]
    def source_key(word):
        source=word.get("source")
        return (source.get("kind"),source.get("id")) if source else None
    def finish():
        if not group: return
        events.append({"start":group[0]["start"],"end":max(word["end"] for word in group),
            "words":[{"t0":word["start"],"t1":word["end"],"text":word["text"]} for word in group]})
        group.clear()
    for index,word in enumerate(valid):
        if group:
            previous=group[-1]
            different_segment=previous.get("segmentId")!=word.get("segmentId") and (previous.get("segmentId") or word.get("segmentId"))
            same_explicit_segment=bool(previous.get("segmentId")) and previous.get("segmentId")==word.get("segmentId")
            if different_segment or source_key(previous)!=source_key(word) and not same_explicit_segment: finish()
        group.append(word)
        if word.get("segmentId"):
            if index==len(valid)-1: finish()
            continue
        punctuation=word["text"].strip()[-1:]
        gap=valid[index+1]["start"]-word["end"] if index+1<len(valid) else float("inf")
        hard=punctuation in ".!?…"
        soft=punctuation in ",;:" or gap>.45
        if index==len(valid)-1 or len(group)>=count or hard or len(group)>=max(2,math.ceil((count+1)/2)) and soft:
            finish()
    finish()
    return events


def _subtitle_file(project,w,h,duration,directory):
    subtitles=project.get("subtitles")
    if not subtitles or not subtitles.get("enabled") or not subtitles.get("words"): return None
    events=_caption_events(subtitles["words"],int(subtitles.get("maxWords",5)))
    style={**vm.SUBTITLE_DEFAULT_STYLE,**subtitles.get("style",{})}
    short_scale=min(w,h)/h
    style["size_frac"]*=short_scale
    style["outline"]*=short_scale
    style["shadow"]*=short_scale
    font_size=max(8,round(style["size_frac"]*h))
    family=style.get("font","Segoe UI")
    font_names={"Segoe UI":("segoeui.ttf","segoeuib.ttf"),"Arial":("arial.ttf","arialbd.ttf"),
        "Verdana":("verdana.ttf","verdanab.ttf"),"Georgia":("georgia.ttf","georgiab.ttf"),
        "Impact":("impact.ttf","impact.ttf"),"Tahoma":("tahoma.ttf","tahomabd.ttf"),
        "Trebuchet MS":("trebuc.ttf","trebucbd.ttf"),"Times New Roman":("times.ttf","timesbd.ttf"),
        "Courier New":("cour.ttf","courbd.ttf")}
    selected=font_names.get(family,("segoeui.ttf","segoeuib.ttf"))[1 if style.get("bold") else 0]
    try: font=ImageFont.truetype(str(Path(os.environ.get("WINDIR",r"C:\Windows"))/"Fonts"/selected),font_size)
    except OSError: font=vm._load_overlay_font(font_size,style.get("bold",True))
    available=w*style.get("width_frac",.88)
    for event in events:
        rows=[]
        start=0
        current=0
        for index,word in enumerate(event["words"]):
            text=word["text"].upper() if style.get("uppercase") else word["text"]
            width=font.getlength(text)
            if current and current+font.getlength(" ")+width>available and len(rows)<int(subtitles.get("maxLines",2))-1:
                rows.append((start,index))
                start=index
                current=0
            current+=width+(font.getlength(" ") if current else 0)
        rows.append((start,len(event["words"])))
        event["rows"]=rows
    if style.get("x") is not None or style.get("y") is not None:
        base_y=style.get("margin_frac",.1) if style.get("position")=="top" else (.5 if style.get("position")=="center" else 1-style.get("margin_frac",.1))
        style["pos"]={"dx":float(style.get("x",.5))-.5,"dy":float(style.get("y",base_y))-base_y}
        if style.get("y") is not None:
            style["position"]="center"
            style["pos"]["dy"]=float(style["y"])-.5
    output=directory/"subtitles.ass"
    vm._write_ass(events,style,w,h,duration,output,int(subtitles.get("maxLines",2)))
    return output


def _prepare_overlays(project,assets,w,h):
    overlays=[]
    for overlay in project.get("overlays") or []:
        kind=overlay["kind"]
        native={"type":"logo" if kind=="image" else kind,"start":overlay["start"],"duration":overlay["end"]-overlay["start"],
            "x":overlay["x"],"y":overlay["y"],"opacity":overlay["opacity"],"anim":overlay.get("animation","fade"),
            "text":overlay.get("text",""),"color":overlay.get("color","#ffffff"),"size":overlay["width"],
            "box":overlay.get("box",False),"box_color":overlay.get("boxColor","#e11d2a"),"box_opacity":overlay.get("boxOpacity",.92)}
        if kind=="text":
            native["size"]=overlay.get("fontSize",overlay["width"] * w / h * .13)
        if kind=="subscribe": native["size"]=overlay.get("fontSize",min(.2,overlay["width"]*w/h/8))
        asset=assets.get(overlay.get("assetId"))
        prepared=vm._prep_overlay(native,asset["path"] if asset else None,w,h)
        if prepared:
            prepared["native_animation"]=overlay.get("animation","fade")
            if kind=="subscribe" and not overlay.get("fontSize"):
                prepared["target_width"]=overlay["width"]*w
            overlays.append(prepared)
    return overlays


def _blend_layers(name,current,incoming,beta):
    current_frame,current_alpha=current
    next_frame,next_alpha=incoming
    if np.all(current_alpha>=1) and np.all(next_alpha>=1):
        return vm._blend_transition(name,current_frame,next_frame,beta),current_alpha
    if name in ("black","white"):
        frame=vm._blend_transition(name,current_frame,next_frame,beta)
        return frame,np.maximum(current_alpha,next_alpha)
    current_premultiplied=(current_frame*current_alpha[:,:,None]).astype(np.uint8)
    next_premultiplied=(next_frame*next_alpha[:,:,None]).astype(np.uint8)
    premultiplied=vm._blend_transition(name,current_premultiplied,next_premultiplied,beta).astype(np.float32)
    current_mask=np.repeat((current_alpha*255).astype(np.uint8)[:,:,None],3,axis=2)
    next_mask=np.repeat((next_alpha*255).astype(np.uint8)[:,:,None],3,axis=2)
    alpha=vm._blend_transition(name,current_mask,next_mask,beta)[:,:,0].astype(np.float32)/255
    frame=np.divide(premultiplied,alpha[:,:,None],out=np.zeros_like(premultiplied),where=alpha[:,:,None]>1e-6)
    return np.clip(frame,0,255).astype(np.uint8),alpha


class VideoEncodingFailure(FfmpegError):
    pass


class GpuCompositionFailure(RuntimeError):
    pass


def _compose_layers(layers,w,h):
    """Blend in native code without full-frame RGB float temporaries."""
    frame=np.zeros((h,w,3),np.uint8)
    for pixels,alpha in layers:
        if np.all(alpha>=1):
            frame=pixels.copy()
        elif np.any(alpha>0):
            # OpenCV rounds to the nearest byte (at most one level from the
            # previous truncation) and parallelizes the work without allocating
            # several 4K x RGB float32 images for each layer and frame.
            frame=cv2.blendLinear(pixels,frame,alpha,1-alpha)
    return frame


def _image_motion(clip,local,duration):
    local=max(0,min(local,duration))
    fi,fo=clip.get("fadeIn",0),clip.get("fadeOut",0)
    opacity=max(0,min(1,local/fi if fi else 1,(duration-local)/fo if fo else 1))
    zoom=clip.get("zoom","none")
    p=min(1,local/max(.001,duration))
    eased=p*p*(3-2*p)
    scale=1 if zoom=="none" else 1+(clip.get("zoomAmount",1.12)-1)*(eased if zoom=="in" else 1-eased)
    return {"key":clip["id"],"scale":scale,"opacity":opacity}


def _render_video_once(project,settings,assets,positions,duration,output,directory,progress,cancel,encoding):
    w,h=_dimensions(project["aspectRatio"],settings["resolution"])
    fps=settings["fps"]
    ass=_subtitle_file(project,w,h,duration,directory)
    frame_png=None
    if settings.get("framePng"):
        encoded=settings["framePng"].split(",",1)[-1]
        data=base64.b64decode(encoded,validate=True)
        frame_file=directory/"frame.png"
        frame_file.write_bytes(data)
        with Image.open(frame_file) as image:
            rgba=np.asarray(image.convert("RGBA").resize((w,h),Image.Resampling.LANCZOS)).astype(np.float32)
        alpha=rgba[:,:,3:4]/255
        frame_png=(rgba[:,:,[2,1,0]].astype(np.uint8),alpha[:,:,0])
    overlays=_prepare_overlays(project,assets,w,h)
    gpu=None
    encoding.composition="cpu"
    encoding.composition_device=None
    if settings.get("acceleration","auto")!="cpu" and not settings.get("_cpu_composition"):
        try:
            from gpu_compositor import ImageCompositor, unsupported_reason
            if unsupported_reason(project,settings) is None:
                gpu=ImageCompositor(w,h)
                encoding.composition="gpu"
                encoding.composition_device=gpu.label
        except (ImportError,RuntimeError,OSError):
            # A driver or optional graphics module can be unavailable. Keep
            # the established CPU compositor and selected video encoder.
            gpu=None
    report_encoding(progress,0,encoding)
    args=[FFMPEG_EXE,"-hide_banner","-loglevel","error","-y","-f","rawvideo","-pix_fmt","bgr24","-s",f"{w}x{h}","-r",str(fps),"-i","pipe:0"]
    if ass: args += ["-vf",f"subtitles={ass.name}"]
    args += ["-an",*encoding.args,"-movflags","+faststart",str(output)]
    try:
        encoder=subprocess.Popen(args,stdin=subprocess.PIPE,stderr=subprocess.PIPE,cwd=str(directory),creationflags=CREATE_NO_WINDOW)
    except Exception:
        if gpu:
            with contextlib.suppress(Exception): gpu.close()
        raise
    errors=[]
    drain=threading.Thread(target=lambda:errors.append(encoder.stderr.read()),daemon=True)
    drain.start()
    sources={}
    uploaded=set()
    video_tracks=[track for track in project.get("tracks",[]) if track["kind"]=="video"]
    known={track["id"] for track in video_tracks}
    for clip,_,_ in positions:
        lane=clip.get("trackId","video-main")
        if lane not in known:
            video_tracks.append({"id":lane,"hidden":False})
            known.add(lane)
    lanes={track["id"]:sorted((entry for entry in positions if entry[0].get("trackId","video-main")==track["id"]),key=lambda entry:entry[1]) for track in video_tracks}
    indices={track["id"]:0 for track in video_tracks}
    def source(entry):
        clip,start,end=entry
        key=clip["id"]
        if key not in sources:
            sources[key]=Source(clip,assets[clip["assetId"]],project,w,h,end-start)
        return sources[key]
    def gpu_layer(entry,local):
        clip,start,end=entry
        if clip["id"] not in uploaded:
            item=source(entry)
            pixels,alpha=item._prepare(item.static,item.static_alpha)
            try:
                gpu.add(clip["id"],pixels,alpha)
            except Exception as error:
                raise GpuCompositionFailure(str(error)) from error
            uploaded.add(clip["id"])
        return _image_motion(clip,local,end-start)
    frames=max(1,round(duration*fps))
    write_error=None
    previous_layers=None
    previous_scene=None
    try:
        for frame_index in range(frames):
            if cancel.is_set(): raise InterruptedError("Esportazione annullata.")
            t=frame_index/fps
            layers=[]
            keep=set()
            for track in reversed(video_tracks):
                if track.get("hidden"): continue
                lane=lanes[track["id"]]
                index=indices[track["id"]]
                while index<len(lane) and t>=lane[index][2]-1e-7: index+=1
                indices[track["id"]]=index
                if index<len(lane):
                    clip,start,end=lane[index]
                    if t<start: continue
                    keep.add(clip["id"])
                    layer=gpu_layer(lane[index],t-start) if gpu else source(lane[index]).frame(t-start)
                    if index+1<len(lane):
                        next_clip,next_start,next_end=lane[index+1]
                        transition=next_clip.get("transition","none")
                        span=min(float(next_clip.get("transitionDuration",.5)),(end-start)/2,(next_end-next_start)/2)
                        if transition!="none" and abs(next_start-end)<.01 and span>0 and end-t<=span:
                            keep.add(next_clip["id"])
                            beta=(span-(end-t))/span
                            if gpu:
                                layer={**layer,"incoming":gpu_layer(lane[index+1],0),"transition":transition,"beta":beta}
                            else:
                                layer=_blend_layers(transition,layer,source(lane[index+1]).frame(0),beta)
                    layers.append(layer)
            if gpu:
                try:
                    frame=gpu.render(layers)
                except Exception as error:
                    raise GpuCompositionFailure(str(error)) from error
            else:
                identical=previous_layers is not None and len(layers)==len(previous_layers) and all(
                    pixels is old_pixels and alpha is old_alpha for (pixels,alpha),(old_pixels,old_alpha) in zip(layers,previous_layers))
                if not identical:
                    previous_scene=_compose_layers(layers,w,h)
                    if frame_png and not overlays:
                        previous_scene=cv2.blendLinear(frame_png[0],previous_scene,frame_png[1],1-frame_png[1])
                    previous_layers=layers
                frame=previous_scene.copy() if overlays else previous_scene
            for overlay in overlays:
                if overlay["start"]<=t<overlay["end"]:
                    p=(t-overlay["start"])/max(.001,overlay["end"]-overlay["start"])
                    if overlay["kind"]=="subscribe": vm._render_subscribe_frame(frame,overlay,p,w,h)
                    else:
                        am,sc,dx,dy=(1,1,0,0) if overlay.get("native_animation")=="none" else vm._overlay_transform(overlay["anim"],p)
                        vm._composite_overlay(frame,overlay["bgr"],overlay["alpha"],overlay["cx"]+dx*w,overlay["cy"]+dy*h,sc,am*overlay["opacity"])
            if frame_png and overlays:
                frame=cv2.blendLinear(frame_png[0],frame,frame_png[1],1-frame_png[1])
            try:
                # A contiguous ndarray implements the buffer protocol; avoid a
                # full extra RGB bytes copy for every high-resolution frame.
                encoder.stdin.write(frame if gpu else memoryview(np.ascontiguousarray(frame)))
            except OSError as error:
                write_error=error
                break
            if frame_index%max(1,round(fps/3))==0: report_encoding(progress,frame_index/frames*.84,encoding)
            for key in list(sources):
                if key not in keep:
                    sources.pop(key).close()
            if gpu:
                try:
                    gpu.release_unused(keep)
                except Exception as error:
                    raise GpuCompositionFailure(str(error)) from error
                uploaded.intersection_update(keep)
    finally:
        for source in sources.values(): source.close()
        if gpu:
            with contextlib.suppress(Exception): gpu.close()
        try: encoder.stdin.close()
        except OSError: pass
        encoder.wait()
        drain.join(timeout=2)
        encoder.stderr.close()
    if cancel.is_set(): raise InterruptedError("Esportazione annullata.")
    if encoder.returncode or write_error:
        raise VideoEncodingFailure((errors[0].decode("utf-8","replace") if errors else f"Codifica video fallita ({encoding.encoder}): {write_error}")[-3000:])


def _render_video(project,settings,assets,positions,duration,output,directory,progress,cancel,provided=None):
    encoding=choose_encoding(settings,provided,cancel)
    report_encoding(progress,0,encoding)
    def render_once(choice):
        try:
            _render_video_once(project,settings,assets,positions,duration,output,directory,progress,cancel,choice)
        except GpuCompositionFailure:
            if cancel.is_set(): raise InterruptedError("Esportazione annullata.")
            Path(output).unlink(missing_ok=True)
            _render_video_once(project,{**settings,"_cpu_composition":True},assets,positions,duration,output,directory,progress,cancel,choice)
    try:
        render_once(encoding)
    except VideoEncodingFailure as error:
        if encoding.encoder=="libx264" or not is_hardware_failure(error) or cancel.is_set():
            raise
        encoding=cpu_encoding(settings.get("quality","standard"),"Encoder GPU non disponibile durante la codifica; ripiego CPU.")
        Path(output).unlink(missing_ok=True)
        report_encoding(progress,0,encoding)
        render_once(encoding)
    return encoding


def _mix_audio(project,assets,positions,duration,video,output,directory,progress,cancel):
    inputs=["-i",str(video)]
    filters=[f"anullsrc=r=48000:cl=stereo,atrim=duration={duration}[silence]"]
    voices=["[silence]"]
    index=1
    tracks=[]
    muted={track["id"] for track in project.get("tracks",[]) if track.get("muted")}
    default_audio=next((track["id"] for track in project.get("tracks",[]) if track["kind"]=="audio"),"audio-main")
    for clip,start,end in positions:
        asset=assets[clip["assetId"]]
        if asset.get("hasAudio") and asset["kind"]=="video" and not clip.get("muted") and clip.get("trackId","video-main") not in muted:
            tracks.append({**clip,"start":start,"fadeIn":clip.get("fadeIn",0),"fadeOut":clip.get("fadeOut",0)})
    tracks += [{**track,"speed":1} for track in project.get("audioTracks",[]) if track.get("trackId",default_audio) not in muted]
    for track in tracks:
        if track["start"]>=duration: continue
        span=(track["out"]-track["in"])/track.get("speed",1)
        inputs += ["-ss",str(track["in"]),"-t",str(track["out"]-track["in"]),"-i",assets[track["assetId"]]["path"]]
        chain=[f"[{index}:a:0]asetpts=PTS-STARTPTS",_atempo_chain(track.get("speed",1)),"aresample=48000","aformat=channel_layouts=stereo",f"volume={track['volume']}","apad",f"atrim=duration={span}"]
        if track.get("fadeIn",0): chain.append(f"afade=t=in:st=0:d={track['fadeIn']}")
        if track.get("fadeOut",0): chain.append(f"afade=t=out:st={span-track['fadeOut']}:d={track['fadeOut']}")
        chain.append(f"adelay={round(track['start']*1000)}:all=1")
        label=f"[voice{index}]"
        filters.append(",".join(chain)+label)
        voices.append(label)
        index+=1
    ringing=[overlay["start"] for overlay in project.get("overlays",[]) if overlay["kind"]=="subscribe" and overlay.get("sound",True)]
    if ringing:
        chime=directory/"chime.wav"
        vm._write_wav(chime,vm._synth_chime())
        for start in ringing:
            inputs += ["-i",str(chime)]
            filters.append(f"[{index}:a]aformat=channel_layouts=stereo,adelay={round(start*1000)}:all=1,volume=0.9[chime{index}]")
            voices.append(f"[chime{index}]")
            index+=1
    filters.append("".join(voices)+f"amix=inputs={len(voices)}:duration=first:normalize=0:dropout_transition=0[voice]")
    music=project.get("music")
    final="[voice]"
    if music and music["start"]<duration:
        available=duration-music["start"]
        span=music["out"]-music["in"]
        inputs += ["-ss",str(music["in"]),"-t",str(span),"-i",assets[music["assetId"]]["path"]]
        chain=[f"[{index}:a]asetpts=PTS-STARTPTS","aresample=48000","aformat=channel_layouts=stereo"]
        if music.get("loop"): chain.append(f"aloop=loop=-1:size={round(span*48000)}")
        phase=music.get("phase",0)
        chain += [f"atrim=start={phase}:duration={available}","asetpts=PTS-STARTPTS",f"volume={music['volume']}",f"adelay={round(music['start']*1000)}:all=1","apad",f"atrim=duration={duration}"]
        filters.append(",".join(chain)+"[music]")
        if music.get("duck"):
            filters += ["[voice]asplit=2[voicemain][sidechain]","[music][sidechain]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=300[ducked]","[voicemain][ducked]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mixed]"]
        else:
            filters.append("[voice][music]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mixed]")
        final="[mixed]"
    filters.append(final+"alimiter=limit=0.95:level=0[audio]")
    script=directory/"audio-filter.txt"
    script.write_text(";".join(filters),encoding="utf-8")
    run_ffmpeg([*inputs,"-filter_complex_script",str(script),"-map","0:v:0","-map","[audio]","-c:v","copy","-c:a","aac","-b:a","192k","-t",str(duration),"-movflags","+faststart",str(output)],duration=duration,on_progress=lambda p:progress(.84+.16*p,"Mixaggio dell'audio"),cancel=cancel)


def render_project(project,settings,output,progress,cancel,encoding=None):
    assets={asset["id"]:asset for asset in project["assets"]}
    positions,duration=_positions(project)
    if duration<=0: raise ValueError("La timeline è vuota.")
    with tempfile.TemporaryDirectory(prefix="render-",dir=str(Path(output).parent)) as temporary:
        directory=Path(temporary)
        video=directory/"video.mp4"
        chosen=_render_video(project,settings,assets,positions,duration,video,directory,progress,cancel,encoding)
        _mix_audio(project,assets,positions,duration,video,Path(output),directory,progress,cancel)
    return {"path":str(output),"encoding":chosen.diagnostic()}
