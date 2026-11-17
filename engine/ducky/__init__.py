"""DuckyPlay — libreria core per estrazione di screen e clip da video.

Moduli:
- config        percorsi e costanti (gestisce anche l'esecuzione da .exe)
- utils         cartelle/file numerati, ordinamento naturale, formati tempo
- ffmpeg_tools  wrapper di ffmpeg con progresso reale e gestione errori
- video         probe, frame singoli e strisce di miniature (OpenCV)
- frames        estrazione screen con ritaglio e rimozione zone (inpaint)
- clips         estrazione clip (crop + velocità in un solo passaggio) e split
- download      download da URL via yt-dlp (libreria, con fallback)
- images        unione cartelle di immagini e aumento luminosità
- shorts         rendering di short verticali con tracking del soggetto
- highlights     analisi dei momenti salienti per gli short
- semantic       trascrizione audio + CLIP per Video Make (IA locale)
- videomake      montaggio video da immagini + audio + intro/outro + logo
- jobs          gestore di operazioni in background con progresso
- dialogs       finestre di dialogo native di Windows (apri/salva/cartella)
"""

__version__ = "2.3.0"
