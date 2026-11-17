# Pubblicare DuckyMovie su GitHub

Git conserva il codice sorgente. Gli installer vanno allegati alle **Releases**:
la cartella `release/` è esclusa dal repository insieme a dipendenze, cache,
modelli scaricati, build, risultati dei test, progetti personali e credenziali locali.
Le immagini dell'interfaccia, i caratteri, le licenze e `package-lock.json` restano
nel repository per permettere di ricompilare il programma.

## Prima pubblicazione del repository

Il repository locale è inizializzato sul ramo `main`. La creazione del primo
commit e il caricamento su GitHub restano operazioni manuali.

1. Su GitHub crea un repository chiamato `DuckyMovie`, senza aggiungere README,
   licenza o `.gitignore`: questi file esistono già nel progetto.
2. Controlla i file in sospeso ed esegui il primo commit con questo titolo:
   `Initial DuckyMovie release with Windows installer`.
3. Collega il repository e pubblica il ramo. Sostituisci `TUO-UTENTE` con il tuo
   account oppure usa l'URL esatto mostrato da GitHub:

   ```powershell
   git remote add origin https://github.com/TUO-UTENTE/DuckyMovie.git
   git push -u origin main
   ```

Puoi anche aprire la cartella con **GitHub Desktop → File → Add local repository**,
creare il primo commit e usare **Publish repository**. Per consentire download
pubblici, il repository deve essere pubblico.

Riferimento: [aggiungere un progetto locale a GitHub](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github).

## Generare un unico file da scaricare

Per ricompilare da una copia pulita su Windows servono Node.js 22.12 o successivo
compatibile e CPython 3.12 x64. Dalla radice del progetto:

```powershell
npm ci
py -3.12 -m venv engine/.venv
& engine/.venv/Scripts/python.exe -m pip install -r engine/requirements.txt
npm run build:engine
npm run package:installer
```

Se il motore è già compilato e aggiornato, basta `npm run package:installer`.
Il comando non crea commit, tag, push o Release online.

Per la versione 0.6.1 il risultato è:

```text
release/installers/DuckyMovie-Setup-0.6.1-Windows-x64.exe
```

È un installer completo, con scelta della cartella di installazione e
collegamenti nel menu Start e sul desktop. L'utente scarica solo questo file:
non deve installare Node.js o Python. I modelli facoltativi vengono scaricati
dall'app al primo utilizzo. La disinstallazione conserva i dati dell'app.

L'eseguibile `win-unpacked/DuckyMovie.exe` richiede le cartelle accanto a sé:
non va allegato da solo. Per distribuire la versione portatile senza installazione
usa invece lo ZIP prodotto da `npm run package`.

L'installer attuale non ha una firma digitale: Windows può mostrare l'avviso
di autore non verificato. Per una distribuzione firmata serve un certificato
di firma del codice, da tenere fuori da Git.

## Creare la Release

1. Dopo aver pubblicato il commit su GitHub, apri il repository e scegli
   **Releases → Draft a new release** (oppure **Create a new release**).
2. In **Choose a tag** crea `v0.6.1` con destinazione `main` e usa
   `DuckyMovie 0.6.1` come titolo della Release.
3. Scrivi una breve descrizione e trascina nella sezione degli allegati
   **soltanto `DuckyMovie-Setup-0.6.1-Windows-x64.exe`**. Attendi la fine del caricamento.
4. Seleziona **Set as latest release** e premi **Publish release**.
5. Copia il collegamento dell'allegato `.exe` per condividere il download diretto.

GitHub aggiunge automaticamente anche gli archivi **Source code (zip)** e
**Source code (tar.gz)**. Sono copie dei sorgenti: il programma pronto da
installare rimane il file Setup `.exe`. Un repository pubblico rende pubblici
anche i sorgenti; una Release non nasconde il codice.

Ogni allegato deve essere inferiore a 2 GiB. Non caricare `node_modules`,
`engine-dist` o `win-unpacked`: sono già contenuti nell'installer.

Riferimenti: [creare una Release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository),
[allegati e archivi dei sorgenti](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

## Versioni successive

Aggiorna `version` in `package.json` e il corrispondente `package-lock.json`.
Se distribuisci anche lo ZIP, aggiorna il percorso `build.directories.output`
e il launcher `Avvia DuckyMovie.cmd`. Ricompila il motore quando cambia il
codice Python, genera l'installer, verifica il programma e pubblica una nuova
Release con il tag della stessa versione, allegando il nuovo Setup `.exe`.
