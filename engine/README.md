# Motore DuckyMovie

Il programma `DuckyMovieEngine.exe` esegue analisi dei punti salienti, trascrizione con tempi delle parole, abbinamento semantico delle immagini, generazione degli short e composizione avanzata dei progetti. Electron lo avvia come processo locale con una richiesta JSON in un file. Il worker restituisce progresso, risultato o errore su righe JSON dello standard output. L'annullamento su Windows termina il processo e i suoi processi FFmpeg.

`ducky/` contiene copie adattate dei moduli di DuckyPlay. Il progetto originale è stato letto e copiato. Le copie di DuckyMovie hanno configurazione e cache proprie. Il pacchetto distribuito funziona con il runtime Python incluso in `_internal`, insieme a FFmpeg incluso in DuckyMovie.

## Ricostruzione da sorgente

Serve CPython 3.12 x64 per preparare il motore. Dalla radice del progetto, con il launcher Python installato, eseguire in PowerShell i seguenti comandi.

```powershell
py -3.12 -m venv engine/.venv
& engine/.venv/Scripts/python.exe -m pip install -r engine/requirements.txt
& scripts/build-engine.ps1 -Python engine/.venv/Scripts/python.exe
```

Il risultato completo è `engine-dist/DuckyMovieEngine/`. Conservare l'eseguibile insieme alla cartella `_internal`. La configurazione PyInstaller è `worker.spec`. Lo script imposta `PYTHONDONTWRITEBYTECODE=1` e usa `-B`, scrive gli intermedi in `engine-build/` e il risultato in `engine-dist/`.

La distribuzione Electron copia questa cartella in `resources/engine/`. Durante lo sviluppo il bridge cerca `engine-dist/DuckyMovieEngine/DuckyMovieEngine.exe`.

## Modelli e cache

Whisper small usa CTranslate2 su CPU con precisione int8. L'abbinamento usa Jina CLIP v1 tramite fastembed e ONNX Runtime. I modelli vengono scaricati al primo utilizzo e riutilizzati dalla cache.

Electron imposta `DUCKY_MODELS_DIR` alla sottocartella `models` della propria directory dati utente. `DUCKY_MODELS_DIR` può indicare una cache già preparata. Per usare una copia di una cache esistente, copiare i relativi alberi completi `models--...`, mantenendo snapshot e blob. Le prove offline possono impostare `HF_HUB_OFFLINE=1` dopo aver preparato tutti i modelli richiesti.

`DUCKY_FFMPEG_PATH` e `DUCKY_FFPROBE_PATH` indicano i binari inclusi nell'applicazione. `DUCKY_CACHE_DIR` contiene le anteprime e gli short intermedi. Le cartelle dei modelli vengono mantenute fuori dal pacchetto dell'applicazione.

## Protocollo

```powershell
& engine-dist/DuckyMovieEngine/DuckyMovieEngine.exe --request richiesta.json
```

Una richiesta contiene `action` e `payload`. Le azioni supportate sono `health`, `highlights`, `transcribe`, `match`, `short-base`, `read-script` e `render`. Gli eventi hanno `type` uguale a `progress`, `result` o `error`. Il bridge Electron valida i progetti e i percorsi, riserva file temporanei e sostituisce il file finale dopo il completamento.

Il rendering avanzato compone i frame con OpenCV e Pillow, riusa le primitive di transizione e animazione di DuckyPlay, genera sottotitoli ASS e usa FFmpeg per H.264 e AAC. La cornice PNG proviene dalla stessa funzione Canvas usata dall'anteprima. Il percorso FFmpeg esistente continua a gestire i progetti che usano gli strumenti di montaggio di base.

## Codifica accelerata e prestazioni

L'impostazione `acceleration` accetta `auto` o `cpu`. In automatico Electron prova realmente NVIDIA NVENC, Intel Quick Sync e AMD AMF con il FFmpeg incluso, quindi passa al worker l'encoder disponibile. Il worker esegue la stessa verifica quando è avviato direttamente o genera uno short. La presenza del nome in `ffmpeg -encoders` non basta: la verifica produce tre frame H.264 e rileva anche driver mancanti o dispositivi non accessibili. Una GPU che smette di funzionare durante la codifica provoca un solo nuovo tentativo CPU; annullamenti ed errori dei media/filtri non vengono mascherati come fallback hardware. Gli eventi e il risultato indicano l'encoder effettivo e l'eventuale ripiego.

Il compositing OpenCV/Pillow, gli effetti, i sottotitoli e il mix audio restano su CPU. I driver GPU non vengono installati dall'applicazione e non sono richiesti: `libx264` resta il percorso compatibile. Non viene forzata la decodifica hardware per pipeline che richiedono fotogrammi CPU.

Il renderer conserva crop, rotazione, adattamento e sfocatura delle immagini statiche; conserva anche il risultato finale delle foto ferme. Zoom, dissolvenze, animazioni e posizionamento continuano a dipendere dal tempo. I video vengono letti in sequenza, saltando fotogrammi quando necessario; un seek viene effettuato sui salti reali, evitando di ripartire dal fotogramma chiave per ogni frame del filmato. Le cache appartengono a una singola sorgente del progetto e vengono liberate quando la sorgente esce dalle corsie attive.

`tests/engine-encoding.py` verifica cache, zoom/fade, lettura video con velocità e salti, fallback reale FFmpeg e coerenza dei frame CPU/GPU decodificati. `tests/engine-performance.py --output test-results/performance.json` misura preparazione delle foto e un'esportazione 1080p riproducibile. `--acceleration cpu` permette di separare il beneficio delle cache dalla scelta dell'encoder; `--renderer percorso/snapshot.py` permette il confronto con una versione precedente. Le misure dipendono da contenuti, risoluzione, driver e durata: le clip brevi possono essere dominate dall'avvio del processo e dal probe hardware.

## Shorts e inquadratura

Il tracker nativo (`ducky/tracking.py`) analizza otto campioni al secondo. Combina volti Haar, persone HOG, descrittori cromatici del soggetto, previsione della posizione e flusso ottico Lucas–Kanade verificato nei due sensi. Conserva il bersaglio nelle brevi occlusioni, usa una zona morta per evitare tremolii e azzera l'associazione agli stacchi di scena. È associazione visiva locale, non riconoscimento dell'identità o comprensione della scena.

`short-base` accetta facoltativamente `tracking: {focusX, focusY, mode, sensitivity}`: il punto è normalizzato sul fotogramma sorgente, `mode` è `person` o `group`, `sensitivity` è `steady` o `responsive`. Restituisce il percorso e le statistiche diagnostiche del tracking. Il formato resta 1080×1920; quando due persone non entrano materialmente in un crop verticale, la modalità gruppo mantiene l'inquadratura più larga sopra uno sfondo sfocato. Lo stile `blur` conserva il video intero.

Gli highlights combinano energia, movimento, cambi scena e segmenti vocali rilevati con il piccolo Silero VAD già incluso in faster-whisper. L'analisi vocale usa blocchi di trenta secondi sovrapposti e non richiede Whisper o download. I bordi preferiscono pause e stacchi, le proposte finali non si sovrappongono e la selezione favorisce distanza temporale e contenuti cromatici diversi. I punteggi sono euristici e non misurano il significato del discorso.

## Verifica

`tests/advanced-engine.test.ts` prova il worker autonomo e l'esportazione avanzata con file sintetici. `tests/engine-tracking.py` verifica associazione, incroci, occlusioni, stacchi, gruppi, flusso ottico e selezione degli highlights; `tests/shorts-engine.test.ts` decodifica lo short prodotto dal worker e misura la visibilità del bersaglio. `tests/ai-live.ts` esegue una prova con i modelli locali preparati. I testi di licenza delle dipendenze sono mantenuti nei dati PyInstaller e riepilogati in `THIRD_PARTY_NOTICES.md` alla radice.
