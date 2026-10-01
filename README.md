## ⚠️ Disclaimer

This project does not promote, encourage, or endorse piracy or unauthorized torrenting. It is intended for personal and educational use only. Users are responsible for ensuring that any media they access or download complies with applicable laws and that they have the necessary rights or permissions.

# Host-Music
---
I got frustrated with Lidarr downloading every single song from an artist's entire torrent discography, when all I actually wanted was a handful of specific songs, organized into my own folders.

So I built this instead.

Host-Music is a Discord bot that connects to your own server. You type a simple command in your Discord chat, and it downloads the exact song you asked for — straight into the folder you assign — with clean cover art and a proper "Artist - Title" name, pulled from iTunes' metadata.

No bulk downloads you don't want. No messy filenames. Just the songs you ask for, tagged properly, ready for Navidrome (or any music server) to pick up.


## 📑 Index

- [Requirements](#-requirements)
- [Setup](#️-setup)
- [Getting Your Credentials](#-getting-your-credentials)
- [Command Guide for Bot](#-command-guide-for-bot)
- [Contributing](#-contributing)
- [License](#-license)

## Requirements
---
- **[Node.js](https://nodejs.org/)** (v18 or higher) — runs the bot itself
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — downloads the audio
- **[FFmpeg](https://ffmpeg.org/download.html)** — converts audio and embeds cover art/metadata
- **[Discord bot token](https://discord.com/developers/applications)** — create an application and bot to get your token
- A running **[Navidrome](https://www.navidrome.org/)** server (or any music server that reads folders + ID3 tags)
- Python 3 (comes pre-installed on most Linux systems) — needed for the iTunes metadata lookup script


## Setup
---

**1. Clone the repository**
```bash
git clone https://github.com/Siddhartha-Kuna/Host-Music.git
cd Host-Music
```

**2. Install dependencies**
```bash
npm install
```

**3. Create your config file**

Copy the example config and fill in your own values:
```bash
cp config.example.json config.json
```

Then open `config.json` and fill in:
- `DISCORD_TOKEN` — your bot's token from the Discord Developer Portal
- `MUSIC_BASE_PATH` — the folder on your server where songs should be saved
- `REQUEST_CHANNEL` — the Discord channel name where requests are allowed
- `STATUS_CHANNEL` — the channel name where download status updates get posted
- `NAVIDROME_URL`, `NAVIDROME_USER`, `NAVIDROME_PASS` — your Navidrome server details (used to trigger a library scan after each download)

**4. Run the bot**
```bash
node bot.js
```

For it to keep running in the background and restart automatically, use a process manager like [PM2](https://pm2.keymetrics.io/):
```bash
npm install -g pm2
pm2 start bot.js --name musicbot
pm2 save
```


## Getting Your Credentials
---
### MUSIC_BASE_PATH

This is just a folder on your server where songs will be saved. If it doesn't exist yet, create it:
```bash
mkdir -p /path/to/your/Music
```
Then use that path in `config.json`, e.g. `/mnt/data/Music`.

### NAVIDROME_URL, NAVIDROME_USER, NAVIDROME_PASS

- `NAVIDROME_URL` is the address of your running Navidrome instance, including the port — e.g. `http://100.xxx.x.xx:xxxx`
- `NAVIDROME_USER` and `NAVIDROME_PASS` are the login credentials for any Navidrome user account (used only to trigger a library scan after each download — it doesn't need admin rights)

To confirm your Navidrome credentials actually work before adding them to `config.json`, test them with:
```bash
curl "http://YOUR_NAVIDROME_URL/rest/ping?u=YOUR_USER&p=YOUR_PASS&v=1.16.1&c=test&f=json"
```
If it responds with `"status":"ok"`, your credentials are correct.

### DISCORD_TOKEN

**1. Create the application**
- Go to the [Discord Developer Portal](https://discord.com/developers/applications)
- Click **New Application** (top-right)
- Give it a name (e.g. "MusicRequestBot") and click **Create**

**2. Get your bot token**
- In the left sidebar, click **Bot**
- Click **Reset Token** → confirm → copy the token that appears
- ⚠️ This token is only shown once. Save it somewhere safe — anyone with it can control your bot.
- This is the value you'll put in `DISCORD_TOKEN` in your `config.json`

**3. Enable the required intent**
- Still on the **Bot** page, scroll down to **Privileged Gateway Intents**
- Turn ON **Message Content Intent** — without this, the bot can see that a message was sent, but not what it actually says, so it won't be able to read your `!request` commands

**4. Invite the bot to your server**
- In the left sidebar, click **OAuth2** → **URL Generator**
- Under **Scopes**, check the box for `bot`
- A new box labeled **Bot Permissions** will appear below — check these four:
  - **View Channels**
  - **Send Messages**
  - **Embed Links**
  - **Read Message History**
- Scroll down and copy the **Generated URL**
- Paste that URL into your browser, choose your server from the dropdown, and click **Authorize**

**5. Create the request channel**
- In your Discord server, create a text channel with `request-song` in its name (or whatever you set `REQUEST_CHANNEL` to in your config)
- The bot only listens for `!request` commands in a channel matching that name
  
  
## 🎧 Command Guide for Bot
---
### Index
- [Single Song](#single-song)
- [Bulk Request](#bulk-request)
- [From a Direct Link](#from-a-direct-link)
- [Folders](#folders)
- [Known Limitations](#known-limitations)

All commands start with `!request` and only work in your configured request channel.

### Single song

```
!request Song Name /Folder
```
Example:
```
!request Blinding Lights /Pop
```
This shows 5 buttons — pick one within 30 seconds:

- 🎵 **Original** — the actual song, with clean iTunes metadata
- 🌊 **Slowed + Reverb**
- ⚡ **Sped Up**
- 🎸 **Instrumental**
- 🎤 **Live**

> Only **Original** gets clean metadata. The others search for altered versions on YouTube, which won't match anything in iTunes' catalog, so they keep the raw YouTube title/artist instead.

💡 Adding the artist name usually gets a better match:
```
!request Cruel Summer Taylor Swift /Pop
```

### 📥 Bulk request

Download multiple songs at once into the same folder (max 30 per request):

```
!request /Folder
Song One
Song Two
Song Three
```
Example:
```
!request /Pop
Snooze SZA
Vampire Olivia Rodrigo
Kill Bill SZA
```

Every song in a bulk request downloads the **Original** version automatically — no button picker. You'll see a live progress embed as it works through the list.

### 🔗 From a direct link

Use this for a specific video/link (e.g. an Instagram reel, or when the name search picks the wrong video):

```
!request LINK [Song Name] /Folder
```
Example:
```
!request https://youtube.com/watch?v=xxxx [My Song] /Pop
```
The name in `[square brackets]` is what the song will be tagged and saved as.

### 📁 Folders

The folder you type after `/` is where the song gets saved. New folders are created automatically if they don't exist.

- `/Pop`, `/Phonk`, `/Rock`
- Sub-folders work too: `/Anime/Naruto`

The **first** folder name becomes the song's **genre** tag, and the **last** folder name becomes its **album** tag.

### ⚠️ Known Limitations

- If a song already exists in that folder, the download is silently skipped — the bot may still say "Downloaded!" even though nothing new happened.
- Songs shorter than 60 seconds or longer than 15 minutes are automatically skipped when searching by name, to avoid grabbing teaser clips or full-album uploads.
- Metadata comes from Apple's free iTunes Search API — it's fast and free, but occasionally won't find a match for very obscure or newly released songs, in which case the raw YouTube title is kept instead.
  
## 🤝 Contributing

Found a bug or have an idea for a feature? Contributions are welcome.

1. Fork the repository
2. Create a new branch for your change
3. Make your changes and test them
4. Open a pull request describing what you changed and why

## 📜 License
---
This project is licensed under the [MIT License](LICENSE) — free to use, modify, and share.
