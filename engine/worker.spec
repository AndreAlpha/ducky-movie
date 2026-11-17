from pathlib import Path
import sys
from PyInstaller.utils.hooks import collect_all, copy_metadata

root = Path(SPECPATH)
datas = []
python_license = Path(sys.base_prefix) / 'LICENSE.txt'
if python_license.is_file():
    datas.append((str(python_license), 'licenses/python'))
datas += copy_metadata('pyinstaller')
binaries = []
hidden = ['renderer', 'ducky.videomake', 'ducky.semantic', 'ducky.shorts', 'ducky.highlights', 'ducky.tempo']
for package in ['cv2', 'numpy', 'PIL', 'faster_whisper', 'ctranslate2', 'av', 'fastembed', 'onnxruntime', 'tokenizers', 'huggingface_hub', 'docx']:
    package_data, package_binaries, package_imports = collect_all(package)
    datas += package_data
    binaries += package_binaries
    hidden += package_imports

analysis = Analysis([str(root / 'worker.py')], pathex=[str(root)], binaries=binaries,
    datas=datas, hiddenimports=hidden, excludes=['tkinter', 'matplotlib', 'torch', 'tensorflow', 'IPython', 'pytest'], noarchive=False)
archive = PYZ(analysis.pure)
program = EXE(archive, analysis.scripts, [], exclude_binaries=True, name='DuckyMovieEngine',
    debug=False, strip=False, upx=False, console=True)
collection = COLLECT(program, analysis.binaries, analysis.datas, strip=False, upx=False, name='DuckyMovieEngine')
