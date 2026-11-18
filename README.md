# DuckyMovie

Editor video desktop per Windows con interfaccia italiana, libreria locale,
anteprima e timeline. Il montaggio e l’esportazione avvengono sul computer.

## Avvio su Windows

Per installare DuckyMovie, scarica dalla sezione **Releases** di GitHub il file
`DuckyMovie-Setup-0.6.2-Windows-x64.exe`, aprilo e segui la procedura guidata.
È un unico download con applicazione, FFmpeg e motore Python inclusi. I modelli
facoltativi di trascrizione e analisi vengono scaricati al primo utilizzo.

In alternativa, puoi usare la versione ZIP portatile descritta qui sotto.

Apri `Avvia DuckyMovie.cmd` nella cartella del progetto. Se la versione compilata
è presente, il file avvia direttamente `release/0.6.2/win-unpacked/DuckyMovie.exe`.

Per trasferirlo su un altro PC Windows x64, estrai completamente
`release/0.6.2/DuckyMovie-0.6.2-Windows-x64.zip` e apri `DuckyMovie.exe` nella cartella
estratta. Electron, FFmpeg, FFprobe e il motore di montaggio sono inclusi:
non occorre installare Python sul PC di destinazione.

## Montare un film

- Importa video, foto e musica con **Importa media**, Ctrl+I o trascinando file
  nella finestra. La prima importazione prepara miniature e anteprime compatibili.
- Il selettore dei file riparte dall’ultima cartella utilizzata, anche dopo un
  riavvio. Annullare un’importazione conserva la cartella precedente.
- In **I miei media**, il contorno evidenzia la selezione: usa un clic, Ctrl+clic,
  Maiusc+clic o **Seleziona tutti**. Trascina dal vuoto per selezionare con un
  rettangolo tratteggiato; Ctrl o Maiusc aggiungono alla selezione. Il lazo scorre
  la libreria quando raggiungi il bordo. Un clic nel vuoto deseleziona i media;
  Esc durante il lazo ripristina la selezione precedente.
  Puoi aggiungere o trascinare l’intera selezione nella timeline in un’operazione,
  oppure usare **Monta la selezione**. Ctrl+A seleziona i media quando la libreria
  ha il focus; Esc annulla la selezione. La ricerca limita i media selezionabili.
- Premi **Canc** nella libreria per rimuovere i media selezionati dal progetto.
  Se sono usati nel film, una conferma avvisa della rimozione anche dalla timeline:
  le altre clip restano al loro posto e vengono conservati gli spazi vuoti.
  Sono rimossi anche loghi, musica e sottotitoli collegati ai media eliminati.
  **Ctrl+Z** annulla l'operazione; i file originali sul computer restano intatti.
- Trascina uno o più media nel punto desiderato della traccia. Se lo spazio è
  occupato, le clip successive sulla stessa traccia scorrono verso destra.
  Se inserisci dentro una clip, viene divisa nel punto scelto. I sottotitoli
  collegati seguono la loro sorgente. **Ctrl+Z** annulla l’intero inserimento.
- **+** e il doppio clic inseriscono al cursore e lo portano alla fine del nuovo
  media, così puoi costruire una sequenza con più clic.
- Seleziona una clip e trascina i bordi per ritagliarla. Ctrl+B divide la clip al
  cursore. Trascinando una clip poco sopra una vicina, i bordi si allineano.
  Superata la metà della vicina, la guida passa sul lato opposto. Puoi anche
  usare le frecce della barra per riordinare le clip.
- Nelle proprietà regola velocità, inquadratura, rotazione, colore, volume,
  dissolvenze al nero e titolo sovrapposto.
- **+ Traccia video** e **+ Traccia audio**, sopra la timeline, aggiungono righe
  indipendenti. Una divisione crea due clip sulla stessa traccia. Trascina una
  clip su un’altra traccia per spostarla; fai doppio clic sul nome per rinominarla.
- Le tracce video superiori coprono quelle inferiori. Le proprietà della clip
  regolano posizione, dimensione e opacità per video sovrapposti. L’occhio nasconde
  l’immagine della traccia; l’altoparlante disattiva il suo audio.
- Le clip audio hanno posizione, ritaglio, divisione, volume e dissolvenze indipendenti.
  La durata comprende anche l’audio e le comparse: una registrazione non viene
  troncata alla fine delle immagini. Sono supportati progetti composti solo da audio.
- Trascina un video dalla libreria su una traccia audio per usarne soltanto
  la colonna sonora. Anche sulla traccia audio, il punto di rilascio determina
  dove inserire il nuovo pezzo.
- Trascina il bordo superiore della timeline per ingrandirla. Le tracce vuote
  si possono eliminare con il cestino nella loro intestazione.
- Ctrl+rotellina ingrandisce la timeline intorno al puntatore. **Adatta** mostra
  l’intero montaggio. Il cursore viene seguito anche tornando indietro o saltando
  all’inizio e alla fine; resta nella zona di montaggio, fuori dalle intestazioni.
- **Calamita**, nella barra della timeline, aggancia inizio e fine delle clip
  agli altri elementi e al cursore. Una guida indica il punto di aggancio.
  **N** attiva o disattiva lo strumento; **Alt** lo sospende durante il
  trascinamento. L’impostazione viene ricordata al riavvio.
- Loghi, testi e frasi dei sottotitoli si spostano direttamente nella timeline.
  Trascina il centro per spostarli e i bordi per cambiarne la durata. Le comparse
  sovrapposte occupano righe distinte. Alt disattiva l’aggancio ai bordi vicini;
  le frecce spostano di un fotogramma, Maiusc+freccia di un secondo.
- Un clic seleziona l’elemento e ne apre le proprietà a destra, senza modali.
  Nell’anteprima trascina un logo o un testo per posizionarlo e usa la maniglia
  per ridimensionarlo. Annulla ripristina l’intero trascinamento in un passaggio.
- Scegli il formato orizzontale 16:9, verticale 9:16 o quadrato 1:1.
- Salva con Ctrl+S e riapri i file `.duckymovie` con **Progetti → Apri progetto**.
- **Esporta film** crea un MP4 H.264/AAC a 720p, 1080p, 1440p o 4K, con 24, 25, 30 o 60 fps.
- L’esportazione usa automaticamente la codifica GPU disponibile (NVIDIA,
  Intel o AMD), verificata con una prova reale. Il pannello mostra il motore
  usato; se la GPU non è utilizzabile passa alla CPU. Puoi scegliere **Solo CPU**
  per compatibilità. Nei montaggi di immagini con zoom, dissolvenze e sottotitoli,
  la GPU compone anche le immagini tramite OpenGL. Gli effetti non compatibili
  usano il compositore CPU ottimizzato; il pannello distingue composizione e
  codifica. Il carico della codifica è distinto dal grafico 3D della GPU.

## Video Make e shorts

Le nuove funzioni usano i pannelli e lo stile dell’editor esistente.
Le sezioni della barra laterale e i pulsanti della barra **Montaggio** aprono:

- **Montaggio automatico**: combina foto, video e narrazioni, con ritmo, ordine e
  priorità regolabili. Rispetta la durata delle sorgenti e della voce; intro,
  outro e logo restano modificabili. L’analisi semantica e i sottotitoli sono
  facoltativi: il montaggio di base funziona subito senza scaricare modelli.
  Con la trascrizione attiva, i tagli cercano pause e confini delle frasi.
  Puoi importare un copione `.docx` o `.txt` per l’analisi semantica.
  Il risultato si applica senza chiedere di salvare: **Ctrl+Z** ripristina
  il montaggio precedente e il recupero automatico continua a funzionare.
- **Shorts → Apri studio Shorts**: cerca momenti salienti nel video usando audio, movimento e
  stacchi, oppure imposta un intervallo manuale fino a 180 secondi. Correggi
  entrata e uscita nell’anteprima e scegli sfondo sfocato o inseguimento del
  soggetto. Le proposte preferiscono pause nel parlato e intervalli distinti.
  Puoi indicare il personaggio nell’anteprima, seguire un gruppo e scegliere
  un movimento più stabile o reattivo. L’inseguimento mantiene il bersaglio nelle
  brevi occlusioni e si reinizializza ai cambi di scena; persone molto simili o
  nascoste a lungo possono richiedere un’altra scelta dell’inquadratura.
  Il video verticale si apre come progetto modificabile, senza richiedere un
  salvataggio preliminare. I media
  generati restano nella cartella dati di DuckyMovie e non vengono cancellati
  quando termina l’operazione.
- **Sottotitoli → Trascrivi audio o video**: seleziona file MP3, WAV, M4A o altri
  audio della libreria anche senza video e immagini, oppure scegli le clip della
  timeline. **Trascrivi** è disponibile anche sotto ogni media con audio.
  Controlla il risultato, salva TXT/SRT o aggiungi i sottotitoli al progetto.
  La modalità timeline rispetta ritagli, velocità e posizione delle clip.
  Puoi scegliere la lingua o farla rilevare automaticamente.
- **Sottotitoli** mostra un elenco di frasi modificabili accanto all’anteprima.
  Scrivi direttamente nel testo e conferma uscendo dal campo, con Ctrl+Invio o
  salvando. Usa Cerca e Sostituisci per correggere più occorrenze. Il menu di ogni
  frase permette di dividerla, unirla alla successiva o eliminarla; i dettagli
  mostrano tempi, singole parole e sorgente collegata. I tempi sono cliccabili
  per raggiungere quel punto del film. Il pulsante Stile apre le proprietà a destra.
- Le trascrizioni collegate seguono la clip audio o video quando viene spostata,
  ritagliata, divisa o modificata in velocità. Una nuova trascrizione conserva
  quelle delle altre clip. I progetti precedenti vengono collegati automaticamente
  dove la sorgente è univoca; negli altri casi puoi scegliere la sorgente nei
  dettagli della frase, oppure mantenere tempi liberi.
- **Logo → Importa e inserisci logo**: importa direttamente un’immagine oppure
  scegline una dalla libreria. Le proprietà mostrano subito la comparsa selezionata:
  animazione, posizione, dimensione, opacità e durata. Sono supportati PNG trasparenti.
- **Titoli → Aggiungi testo animato**: crea testo indipendente dalle clip video,
  con animazioni dissolvenza, pop, zoom, scorrimento e respiro. I titoli statici
  per clip restano disponibili nello stesso pannello.
- **Intro / outro**: scegli un video o una foto e inseriscila all’inizio o alla
  fine. L’intro sposta tutte le tracce e i sottotitoli mantenendo la sincronia.
  Puoi sostituire o rimuovere intro e outro e modificarle come normali clip.
- **Proprietà del film**: sottotitoli karaoke con 8 preset, correzione del testo
  e dei tempi, cerca/sostituisci, comparse animate, logo, invito a iscriversi con
  suono, 21 stili di cornice, specchiatura con protezione del logo originale e
  musica ripetuta con attenuazione automatica durante il parlato.

Le proprietà della clip includono ritaglio dell’inquadratura, movimento Ken Burns,
specchiatura, sfondo sfocato e transizioni dissolvenza, nero, bianco, zoom e blur.
Ctrl/clic e Maiusc/clic consentono la selezione multipla nella timeline. Ctrl+A
seleziona tutte le clip; Ctrl+C e Ctrl+V copiano e aggiungono le clip selezionate
alla fine del film. Le impostazioni video comuni si applicano all’intera selezione.

**Progetti → Importa progetto DuckyPlay** converte i progetti Video Make JSON
versione 3. **Salva come modello** conserva intro, outro, stile, musica e comparse;
**Applica modello** accetta anche i modelli DuckyPlay. I file originali devono
essere ancora disponibili: il messaggio di importazione indica quelli mancanti.

Whisper e Jina CLIP scaricano i modelli al primo utilizzo e poi li riusano
localmente nella cartella `models` dei dati dell’app. Serve spazio libero
aggiuntivo di circa 2 GB per i modelli. Video, audio e immagini sono elaborati
sul computer. Analisi ed esportazioni lunghe possono essere annullate dal pannello.

I progetti contengono i riferimenti ai file originali. Per spostare un lavoro,
trasferisci progetto e media conservando la struttura delle cartelle.
Puoi ripristinare un file mancante nella posizione originale e reimportarlo.
La copia di recupero automatico viene proposta dopo un’interruzione dell’app.

## Sviluppo

Occorre Node.js 22.12+ o una versione successiva compatibile con Vite.

```powershell
npm ci
npm run dev
```

Prima dei test completi e della creazione dei pacchetti, prepara il motore nativo
con CPython 3.12 x64 (vedi anche [engine/README.md](engine/README.md)):

```powershell
py -3.12 -m venv engine/.venv
& engine/.venv/Scripts/python.exe -m pip install -r engine/requirements.txt
npm run build:engine
```

Per `test:timeline-ui`, se Chrome non è installato, prepara il browser di prova
con `npx playwright install chromium`.

```powershell
npm run build
npm test
npm run test:ui
npm run test:advanced-ui
npm run test:workflows
npm run test:editing-ui
npm run test:library-ui
npm run test:timeline-ui
npm run test:selection-ui
npm run test:media-removal-ui
npm run package
```

`npm run package` genera la cartella eseguibile e lo ZIP Windows x64 in `release/0.6.2`.
`npm run package:installer` genera un installer Windows x64 in `release/installers`,
con nome `DuckyMovie-Setup-0.6.2-Windows-x64.exe`. Non pubblica file online.
La guida [Pubblicare su GitHub](docs/GITHUB_RELEASES.md) descrive la prima
pubblicazione del repository e delle Release.
I test del motore generano brevi file multimediali e verificano i risultati con
FFprobe. Il test dell’interfaccia avvia Electron con dati isolati e prova importazione,
montaggio, salvataggio, riapertura ed esportazione attraverso l’interfaccia.

L’interfaccia usa React e TypeScript. Electron gestisce dialoghi e filesystem
attraverso un preload isolato. FFmpeg esegue il rendering a segmenti e il mix audio.
La libreria crea anteprime H.264 per i codec video che Chromium non riproduce.

Il motore avanzato è in `engine/`: i dettagli per ricompilarlo prima di creare
un pacchetto pulito sono in [engine/README.md](engine/README.md). `npm run
build:engine` usa per impostazione predefinita `engine/.venv/Scripts/python.exe`.
I modelli scaricati non sono inclusi nello ZIP. DuckyMovie non dipende dalla
cartella DuckyPlay ed è un progetto indipendente da Apple.
