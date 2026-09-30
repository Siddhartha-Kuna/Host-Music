const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const http = require('http');

const execFileAsync = promisify(execFile);
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
});

function capitalize(str) {
  return str.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\?%*:|"<>]/g, '').trim();
}

function triggerNavidromeScan() {
  const params = new URLSearchParams({
    u: config.NAVIDROME_USER,
    p: config.NAVIDROME_PASS,
    v: '1.16.1',
    c: 'musicbot',
    f: 'json'
  });
  const url = `${config.NAVIDROME_URL}/rest/startScan?${params}`;
  http.get(url, (res) => {
    console.log('✅ Navidrome scan triggered, status:', res.statusCode);
  }).on('error', (err) => {
    console.log('Scan trigger failed:', err.message);
  });
}

function findNewFile(folder, before) {
  const files = fs.readdirSync(folder)
    .filter(f => f.endsWith('.mp3'))
    .map(f => ({
      name: f,
      time: fs.statSync(path.join(folder, f)).mtimeMs
    }))
    .filter(f => f.time > before)
    .sort((a, b) => b.time - a.time);
  return files.length > 0 ? path.join(folder, files[0].name) : null;
}

async function getSpotifyMetadata(query) {
  console.log(`[DEBUG] getSpotifyMetadata called with query="${query}"`);
  try {
    const { stdout, stderr } = await execFileAsync(
      '/opt/docker/musicbot/itunes_lookup.py',
      [query],
      { timeout: 15000, maxBuffer: 1024 * 1024 * 10 }
    );
    console.log(`[DEBUG] itunes_lookup.py raw stdout: ${stdout}`);
    if (stderr) console.log(`[DEBUG] itunes_lookup.py raw stderr: ${stderr}`);
    const data = JSON.parse(stdout);
    if (data.error) {
      console.log('Metadata lookup returned no match:', data.error);
      return null;
    }
    console.log(`[DEBUG] getSpotifyMetadata resolved:`, JSON.stringify(data));
    return data;
  } catch (err) {
    console.log('Metadata lookup failed:', err.message);
    return null;
  }
}

async function downloadCoverArt(url) {
  if (!url) return null;
  const tempPath = `/tmp/cover_${Date.now()}_${Math.floor(Math.random() * 100000)}.jpg`;
  try {
    await execFileAsync('curl', ['-s', '-L', '--max-time', '10', '-o', tempPath, url]);
    if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
      return tempPath;
    }
    return null;
  } catch (err) {
    console.log('Cover art download failed:', err.message);
    return null;
  }
}

function cleanupCover(coverPath) {
  if (coverPath) {
    try { fs.unlinkSync(coverPath); } catch (e) {}
  }
}

function buildFfmpegArgs(newFile, coverPath, tempFile) {
  if (coverPath) {
    return ['-i', newFile, '-i', coverPath,
      '-map', '0:a:0', '-map', '1:0',
      '-c:a', 'copy', '-c:v', 'mjpeg',
      '-id3v2_version', '3',
      '-metadata:s:v', 'title=Album cover',
      '-metadata:s:v', 'comment=Cover (front)'];
  }
  return ['-i', newFile, '-c', 'copy'];
}

async function downloadSong(songQuery, savePath, albumTag, genreTag) {
  const beforeTime = Date.now();

  await execFileAsync('yt-dlp', [
    `ytsearch5:${songQuery}`,
    '--match-filter', 'duration > 60 & duration < 900',
    '--no-playlist-reverse',
    '--playlist-items', '1',
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--embed-thumbnail',
    '--add-metadata',
    '--no-playlist',
    '--js-runtimes', 'node:/usr/bin/node',
    '-o', path.join(savePath, '%(artist)s - %(title)s.%(ext)s'),
  ], {
    maxBuffer: 1024 * 1024 * 50,
    env: { ...process.env, PATH: '/home/sid/.local/bin:/usr/local/bin:/usr/bin:/bin' }
  });

  let newFile = findNewFile(savePath, beforeTime);
  if (!newFile) {
    console.log(`[DEBUG] downloadSong: no new file found for query "${songQuery}" — likely a duplicate skip`);
    return songQuery;
  }

  const metadata = await getSpotifyMetadata(songQuery);
  const coverPath = metadata ? await downloadCoverArt(metadata.cover_url) : null;

  const tempFile = newFile.replace('.mp3', '_temp.mp3');
  const ffmpegArgs = buildFfmpegArgs(newFile, coverPath, tempFile);
  if (metadata) {
    ffmpegArgs.push('-metadata', `title=${metadata.title}`, '-metadata', `artist=${metadata.artist}`);
  }
  ffmpegArgs.push(
    '-metadata', `album=${albumTag}`,
    '-metadata', `genre=${genreTag}`,
    '-metadata', `album_artist=Various Artists`,
    '-y', tempFile
  );

  await execFileAsync('ffmpeg', ffmpegArgs, { env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' } });
  cleanupCover(coverPath);
  fs.renameSync(tempFile, newFile);

  if (metadata) {
    const cleanPath = path.join(savePath, `${sanitizeFilename(metadata.artist + ' - ' + metadata.title)}.mp3`);
    if (cleanPath !== newFile) {
      fs.renameSync(newFile, cleanPath);
      newFile = cleanPath;
    }
  }

  return path.basename(newFile, '.mp3');
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.channel.name.includes(config.REQUEST_CHANNEL)) return;
  if (!message.content.startsWith('!request')) return;

  const full = message.content.slice('!request'.length).trim();
  const isUrl = full.startsWith('http://') || full.startsWith('https://');

  if (isUrl) {
    const urlMatch = full.match(/^(https?:\/\/\S+)\s+\[(.+?)\]\s+\/(.+)$/);
    if (!urlMatch) {
      return message.reply('❌ URL format: `!request URL [Song Name] /Folder`\nExample: `!request https://instagram.com/reel/xxx [My Song] /Pop`');
    }

    const url = urlMatch[1].trim();
    const songName = urlMatch[2].trim();
    const folderParts = urlMatch[3].split('/').map(p => capitalize(p.trim())).filter(Boolean);
    const folder = folderParts.join('/');
    const albumTag = folderParts[folderParts.length - 1];
    const genreTag = folderParts[0];
    const savePath = path.join(config.MUSIC_BASE_PATH, folder);

    fs.mkdirSync(savePath, { recursive: true });

    const reply = await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('⬇️ Downloading from URL...')
        .setDescription(`**Song:** ${songName}\n**URL:** ${url.slice(0, 60)}...\n**Save to:** /music/${folder}`)]
    });

    try {
      const beforeTime = Date.now();
      const outputPath = path.join(savePath, `${songName}.%(ext)s`);

      await execFileAsync('yt-dlp', [
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '-o', outputPath,
        '--no-playlist',
        '--js-runtimes', 'node:/usr/bin/node',
        url
      ], {
        maxBuffer: 1024 * 1024 * 50,
        env: { ...process.env, PATH: '/home/sid/.local/bin:/usr/local/bin:/usr/bin:/bin' }
      });

      let newFile = findNewFile(savePath, beforeTime);
      let finalTitle = songName;

      if (newFile) {
        const metadata = await getSpotifyMetadata(songName);
        const coverPath = metadata ? await downloadCoverArt(metadata.cover_url) : null;
        finalTitle = metadata ? metadata.title : songName;

        const tempFile = newFile.replace('.mp3', '_temp.mp3');
        const ffmpegArgs = buildFfmpegArgs(newFile, coverPath, tempFile);
        ffmpegArgs.push('-metadata', `title=${finalTitle}`);
        if (metadata) {
          ffmpegArgs.push('-metadata', `artist=${metadata.artist}`);
        }
        ffmpegArgs.push(
          '-metadata', `album=${albumTag}`,
          '-metadata', `genre=${genreTag}`,
          '-metadata', `album_artist=Various Artists`,
          '-y', tempFile
        );

        await execFileAsync('ffmpeg', ffmpegArgs, { env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' } });
        cleanupCover(coverPath);

        fs.renameSync(tempFile, newFile);
        const cleanFile = path.join(savePath, `${songName}.mp3`);
        if (newFile !== cleanFile) fs.renameSync(newFile, cleanFile);
      }

      triggerNavidromeScan();

      await reply.edit({
        embeds: [new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('✅ Downloaded!')
          .setDescription(`**${finalTitle}**`)
          .addFields(
            { name: '📁 Saved to', value: `/music/${folder}`, inline: true },
            { name: '📀 Shows as', value: albumTag, inline: true },
            { name: '🎧 Quality', value: 'MP3', inline: true }
          )]
      });

      const statusChannel = message.guild.channels.cache.find(c => c.name.includes(config.STATUS_CHANNEL));
      if (statusChannel) {
        statusChannel.send({
          embeds: [new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('📥 New Song Added via URL')
            .setDescription(`**${finalTitle}**`)
            .addFields(
              { name: '📁 Folder', value: `/music/${folder}`, inline: true },
              { name: '📀 Album', value: albumTag, inline: true },
              { name: '👤 Requested by', value: message.author.username, inline: true }
            )
            .setTimestamp()]
        });
      }

    } catch (err) {
      console.error('yt-dlp error:', err.message);
      await reply.edit({
        embeds: [new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle('❌ Download Failed')
          .setDescription(`Couldn't download from URL.\n\`\`\`${err.message.slice(0, 200)}\`\`\``)]
      });
    }

  } else {
    const lines = full.split('\n').map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0];
    const isBulk = firstLine.startsWith('/') && lines.length > 1;

    if (isBulk) {
      const folderParts = firstLine.slice(1).split('/').map(p => capitalize(p.trim())).filter(Boolean);
      const folder = folderParts.join('/');
      const albumTag = folderParts[folderParts.length - 1];
      const genreTag = folderParts[0];
      const savePath = path.join(config.MUSIC_BASE_PATH, folder);

      const songList = lines.slice(1).slice(0, 30);
      const total = songList.length;

      fs.mkdirSync(savePath, { recursive: true });

      const results = { success: [], failed: [] };

      const progressEmbed = () => {
        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle(`📥 Bulk Download — /music/${folder}`)
          .setDescription(
            `**Total:** ${total} songs\n` +
            `✅ Done: ${results.success.length}\n` +
            `❌ Failed: ${results.failed.length}\n` +
            `⏳ Remaining: ${total - results.success.length - results.failed.length}`
          )
          .setTimestamp();

        if (results.success.length > 0) {
          embed.addFields({ name: '✅ Downloaded', value: results.success.map(s => `• ${s}`).join('\n').slice(0, 1024), inline: false });
        }
        if (results.failed.length > 0) {
          embed.addFields({ name: '❌ Failed', value: results.failed.map(s => `• ${s}`).join('\n').slice(0, 1024), inline: false });
        }

        return embed;
      };

      const reply = await message.reply({ embeds: [progressEmbed()] });

      for (const song of songList) {
        try {
          const name = await downloadSong(song, savePath, albumTag, genreTag);
          results.success.push(name);
        } catch (err) {
          console.error(`Failed: ${song}`, err.message);
          results.failed.push(song);
        }
        await reply.edit({ embeds: [progressEmbed()] }).catch(() => {});
      }

      triggerNavidromeScan();

      const finalEmbed = new EmbedBuilder()
        .setColor(results.failed.length === 0 ? 0x57F287 : 0xFEE75C)
        .setTitle(`${results.failed.length === 0 ? '✅' : '⚠️'} Bulk Download Complete!`)
        .setDescription(`**Folder:** /music/${folder}\n**Total:** ${total} songs`)
        .setTimestamp();

      if (results.success.length > 0) {
        finalEmbed.addFields({ name: `✅ Downloaded (${results.success.length})`, value: results.success.map(s => `• ${s}`).join('\n').slice(0, 1024), inline: false });
      }
      if (results.failed.length > 0) {
        finalEmbed.addFields({ name: `❌ Failed (${results.failed.length})`, value: results.failed.map(s => `• ${s}`).join('\n').slice(0, 1024), inline: false });
      }

      await reply.edit({ embeds: [finalEmbed] });

      const statusChannel = message.guild.channels.cache.find(c => c.name.includes(config.STATUS_CHANNEL));
      if (statusChannel) {
        statusChannel.send({
          embeds: [new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('📥 Bulk Download Complete')
            .setDescription(`**${results.success.length}/${total}** songs added to /music/${folder}`)
            .addFields({ name: '👤 Requested by', value: message.author.username, inline: true })
            .setTimestamp()]
        });
      }

    } else {
      const args = full.split('/').map(s => s.trim()).filter(Boolean);
      if (args.length < 2) {
        return message.reply(
          '❌ Formats:\n' +
          '**Single:** `!request Song Name /Folder`\n' +
          '**Bulk:** `!request /Folder` then song names on new lines\n' +
          '**URL:** `!request URL [Song Name] /Folder`'
        );
      }

      const songQuery = args[0].trim();
      const folderParts = args.slice(1).map(p => capitalize(p));
      const folder = folderParts.join('/');
      const albumTag = folderParts[folderParts.length - 1];
      const genreTag = folderParts[0];
      const savePath = path.join(config.MUSIC_BASE_PATH, folder);

      fs.mkdirSync(savePath, { recursive: true });

      const variantRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('original').setLabel('🎵 Original').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('slowed').setLabel('🌊 Slowed + Reverb').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('sped').setLabel('⚡ Sped Up').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('instrumental').setLabel('🎸 Instrumental').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('live').setLabel('🎤 Live').setStyle(ButtonStyle.Primary),
      );

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎵 Music Request')
        .setDescription(`**Song:** ${songQuery}\n**Save to:** /music/${folder}\n\nWhich version?`)
        .setFooter({ text: 'Pick a version below (30s)' });

      const reply = await message.reply({ embeds: [embed], components: [variantRow] });
      const collector = reply.createMessageComponentCollector({ time: 30000 });

      collector.on('collect', async (interaction) => {
        if (interaction.user.id !== message.author.id) {
          return interaction.reply({ content: '❌ Only the requester can pick!', ephemeral: true });
        }

        const variantMap = {
          original:     { search: songQuery,                    label: '' },
          slowed:       { search: `${songQuery} slowed reverb`, label: ' (Slowed + Reverb)' },
          sped:         { search: `${songQuery} sped up`,       label: ' (Sped Up)' },
          instrumental: { search: `${songQuery} instrumental`,  label: ' (Instrumental)' },
          live:         { search: `${songQuery} live`,          label: ' (Live)' },
        };

        const v = variantMap[interaction.customId];
        const isModified = interaction.customId !== 'original';

        console.log(`[DEBUG] button clicked: customId="${interaction.customId}", isModified=${isModified}, songQuery="${songQuery}"`);

        await interaction.update({
          embeds: [new EmbedBuilder()
            .setColor(0xFEE75C)
            .setTitle('⬇️ Downloading...')
            .setDescription(`Searching YouTube Music for **${v.search}**\nDownloading audio...`)],
          components: []
        });

        try {
          const beforeTime = Date.now();

          await execFileAsync('yt-dlp', [
            `ytsearch5:${v.search}`,
            '--match-filter', 'duration > 60 & duration < 900',
            '--no-playlist-reverse',
            '--playlist-items', '1',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '--embed-thumbnail',
            '--add-metadata',
            '--no-playlist',
            '--js-runtimes', 'node:/usr/bin/node',
            '-o', path.join(savePath, '%(artist)s - %(title)s.%(ext)s'),
          ], {
            maxBuffer: 1024 * 1024 * 50,
            env: { ...process.env, PATH: '/home/sid/.local/bin:/usr/local/bin:/usr/bin:/bin' }
          });

          let newFile = findNewFile(savePath, beforeTime);
          let songName = v.search;

          console.log(`[DEBUG] findNewFile result: ${newFile}`);

          if (newFile) {
            const metadata = !isModified ? await getSpotifyMetadata(songQuery) : null;
            const coverPath = metadata ? await downloadCoverArt(metadata.cover_url) : null;
            console.log(`[DEBUG] metadata for "${songQuery}":`, JSON.stringify(metadata));

            const tempFile = newFile.replace('.mp3', '_temp.mp3');
            const ffmpegArgs = buildFfmpegArgs(newFile, coverPath, tempFile);
            if (metadata) {
              ffmpegArgs.push('-metadata', `title=${metadata.title}${v.label}`, '-metadata', `artist=${metadata.artist}`);
            }
            ffmpegArgs.push(
              '-metadata', `album=${albumTag}`,
              '-metadata', `genre=${genreTag}`,
              '-metadata', `album_artist=Various Artists`,
              '-y', tempFile
            );

            await execFileAsync('ffmpeg', ffmpegArgs, { env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' } });
            cleanupCover(coverPath);
            fs.renameSync(tempFile, newFile);

            if (metadata) {
              const cleanPath = path.join(savePath, `${sanitizeFilename(metadata.artist + ' - ' + metadata.title + v.label)}.mp3`);
              if (cleanPath !== newFile) {
                fs.renameSync(newFile, cleanPath);
                newFile = cleanPath;
              }
            }

            songName = path.basename(newFile, '.mp3');
          } else {
            console.log(`[DEBUG] No new file detected — likely duplicate-skip for search "${v.search}"`);
          }

          triggerNavidromeScan();

          await interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor(0x57F287)
              .setTitle('✅ Downloaded!')
              .setDescription(`**${songName}**`)
              .addFields(
                { name: '📁 Saved to', value: `/music/${folder}`, inline: true },
                { name: '📀 Shows as', value: albumTag, inline: true },
                { name: '🎧 Quality', value: 'MP3 320kbps', inline: true }
              )]
          });

          const statusChannel = message.guild.channels.cache.find(c => c.name.includes(config.STATUS_CHANNEL));
          if (statusChannel) {
            statusChannel.send({
              embeds: [new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('📥 New Song Added')
                .setDescription(`**${songName}**`)
                .addFields(
                  { name: '📁 Folder', value: `/music/${folder}`, inline: true },
                  { name: '📀 Album', value: albumTag, inline: true },
                  { name: '👤 Requested by', value: message.author.username, inline: true }
                )
                .setTimestamp()]
            });
          }

        } catch (err) {
          console.error('Error:', err.message);
          await interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor(0xED4245)
              .setTitle('❌ Download Failed')
              .setDescription(`Couldn't find **${v.search}**.\nTry a more specific song name!\n\`\`\`${err.message.slice(0, 200)}\`\`\``)]
          });
        }

        collector.stop();
      });

      collector.on('end', (_, reason) => {
        if (reason === 'time') reply.edit({ components: [] }).catch(() => {});
      });
    }
  }
});

client.login(config.DISCORD_TOKEN);
