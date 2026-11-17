# Componenti di terze parti

DuckyMovie include Electron e Chromium, React, lucide-react e il carattere Inter.
Le relative licenze sono incluse nei pacchetti distribuiti. Inter è distribuito
con la SIL Open Font License, disponibile in `fonts/LICENSE.txt`.

Il rendering avvia FFmpeg e FFprobe come processi locali separati. La build
FFmpeg fornita da ffmpeg-static 5.3.0 proviene dalla release b6.1.1 ed è
distribuita con licenza GPL-3.0-or-later. Il pacchetto ffprobe-static fornisce
il programma FFprobe con le licenze della propria distribuzione.

Progetti, codice sorgente dei wrapper, riferimenti alle build binarie e sorgenti
dei componenti sono disponibili presso i rispettivi autori.

- https://github.com/eugeneware/ffmpeg-static/tree/b6.1.1
- https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
- https://github.com/joshwnj/ffprobe-static
- https://ffmpeg.org/download.html
- https://ffmpeg.org/legal.html
- https://www.electronjs.org/
- https://react.dev/
- https://lucide.dev/license
- https://github.com/rsms/inter

La licenza MIT di DuckyMovie si applica al codice originale del progetto.
I componenti di terze parti conservano le proprie licenze.

Il motore autonomo include CPython e i seguenti componenti Python. I nomi e le
licenze riportati provengono dai metadati delle distribuzioni usate per il build.
I testi completi e gli ulteriori avvisi dei componenti si trovano nelle cartelle
`resources/engine/_internal`, nei dati delle rispettive distribuzioni.

- OpenCV Python 4.13.0.92 è distribuito con Apache License 2.0 e ulteriori avvisi dei componenti inclusi.
- NumPy 2.4.6 dichiara BSD-3-Clause, 0BSD, MIT, Zlib e CC0-1.0 nei propri metadati.
- Pillow 12.2.0 è distribuito con MIT-CMU.
- faster-whisper 1.2.1, CTranslate2 4.8.0, ONNX Runtime 1.26.0 e python-docx 1.2.0 dichiarano licenze MIT.
- fastembed 0.8.0 include Apache License 2.0 e NOTICE.
- tokenizers 0.23.1 e huggingface_hub 1.19.0 dichiarano Apache License 2.0.
- PyAV 17.1.0 dichiara BSD-3-Clause. I binari multimediali inclusi conservano i propri avvisi.
- PyInstaller 6.20.0 usa GPLv2-or-later con la propria eccezione per i programmi distribuiti. CPython conserva il proprio testo di licenza incluso nel runtime.

I moduli di elaborazione adattati da DuckyPlay sono descritti in
`engine/ATTRIBUTION.md`. I modelli Whisper e Jina CLIP sono scaricati e conservati
separatamente nella cache utente, con i metadati delle rispettive distribuzioni.
