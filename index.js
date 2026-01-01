require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ChannelType,
  PermissionsBitField
} = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection
} = require('@discordjs/voice');

const PREFIX = process.env.PREFIX || '.';
const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  console.error('DISCORD_TOKEN is missing in environment variables.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// Basit bellek içi config (gelişmiş sürümde DB kullanabilirsin)
const guildConfig = new Map(); // guildId -> { botVoiceChannelId, ticketCategoryId, roles: {...}, channels: {...} }

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    status: 'dnd',
    activities: [
      {
        name: 'Building support servers | .setup',
        type: 0
      }
    ]
  });

  // Restart sonrası 24/7 ses kanalına tekrar bağlan
  client.guilds.cache.forEach(async (guild) => {
    try {
      const config = guildConfig.get(guild.id);
      let voiceChannel = null;

      if (config && config.botVoiceChannelId) {
        voiceChannel = guild.channels.cache.get(config.botVoiceChannelId);
      }

      if (!voiceChannel) {
        voiceChannel = guild.channels.cache.find(
          (ch) => ch.type === ChannelType.GuildVoice && ch.name.includes('Bot Voice')
        );
      }

      if (voiceChannel) {
        await connectToVoice(guild, voiceChannel);
      }
    } catch (err) {
      console.error(`Error auto-joining voice channel for guild ${guild.id}:`, err);
    }
  });
});

// Mesaj komutları
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  switch (command) {
    case 'ping':
      return handlePing(message);
    case 'stats':
      return handleStats(message);
    case 'setup':
      return handleSetup(message);
    case 'ban':
      return handleBan(message, args);
    case 'kick':
      return handleKick(message, args);
    case 'clear':
      return handleClear(message, args);
    case 'help':
      return handleHelp(message);
    case 'about':
      return handleAbout(message);
    case 'invite':
      return handleInvite(message);
    default:
      return;
  }
});

// Buton etkileşimleri (ticket + setup onay)
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const [key, sub] = interaction.customId.split(':');

  // Setup onay
  if (key === 'setup-confirm') {
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: 'Only administrators can confirm setup.', ephemeral: true });
    }

    if (sub === 'yes') {
      await interaction.update({ content: 'Starting full server setup...', components: [], embeds: [] });
      await runFullSetup(interaction.guild, interaction.user, interaction);
    } else if (sub === 'no') {
      return interaction.update({ content: 'Setup cancelled.', components: [], embeds: [] });
    }
  }

  // Ticket sistemindeki butonlar
  if (key === 'ticket-open') {
    const type = sub; // general / bug / partner
    return handleOpenTicket(interaction, type);
  }

  if (key === 'ticket-close') {
    return handleCloseTicket(interaction);
  }
});

/* ---------------- Komutlar ---------------- */

async function handlePing(message) {
  const embed = new EmbedBuilder()
    .setColor(0x00ff9d)
    .setTitle('Pong!')
    .setDescription(`Latency: \`${Date.now() - message.createdTimestamp}ms\``);

  await message.channel.send({ embeds: [embed] });
}

async function handleStats(message) {
  const embed = new EmbedBuilder()
    .setColor(0x00aaff)
    .setTitle('Bot Stats')
    .addFields(
      { name: 'Servers', value: `${client.guilds.cache.size}`, inline: true },
      { name: 'Users (approx.)', value: `${client.users.cache.size}`, inline: true },
      { name: 'Uptime', value: `${formatUptime(process.uptime())}`, inline: true }
    );

  await message.channel.send({ embeds: [embed] });
}

async function handleHelp(message) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Help Menu')
    .setDescription(
      `Prefix: \`${PREFIX}\`\n` +
        'This bot is a full **Bot Support Server Builder**, with automatic setup, moderation and tickets.'
    )
    .addFields(
      {
        name: 'Setup & Information',
        value:
          `\`${PREFIX}setup\` – Reset the server and build the full support structure (Admin only).\n` +
          `\`${PREFIX}stats\` – Show bot statistics (servers, users, uptime).\n` +
          `\`${PREFIX}ping\` – Check bot latency.\n` +
          `\`${PREFIX}about\` – Learn what this bot does.\n` +
          `\`${PREFIX}invite\` – Get the bot invite link.`
      },
      {
        name: 'Moderation Commands',
        value:
          `\`${PREFIX}ban @user [reason]\` – Ban a member from the server.\n` +
          `\`${PREFIX}kick @user [reason]\` – Kick a member from the server.\n` +
          `\`${PREFIX}clear <1-100>\` – Bulk delete messages in the current channel.`
      },
      {
        name: 'Ticket System',
        value:
          'Use the buttons in `#🎫-ticket-create` to open support tickets:\n' +
          '- 🛠 General Support – For normal help about the bot or server.\n' +
          '- 🐞 Bug Report – To report bugs or issues.\n' +
          '- 🤝 Partnership – For partnership and collaboration requests.\n' +
          'Each ticket creates a **private channel** visible only to you and staff.'
      },
      {
        name: 'Notes',
        value:
          '- `.setup` will **delete existing channels and roles** (that the bot can manage) and rebuild the server.\n' +
          '- The bot creates emoji-rich channels, roles, rules embeds, staff-only areas and log channels.\n' +
          '- A dedicated `🔊 Bot Voice` channel is created and the bot joins it automatically (muted & deafened).'
      }
    )
    .setFooter({ text: 'Bot Support Server Builder – generated from Copilot spec.' });

  await message.channel.send({ embeds: [embed] });
}

async function handleAbout(message) {
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('About This Bot')
    .setDescription(
      'This bot is designed to build a **complete Bot Support Server** automatically:\n\n' +
        '- Deletes old channels and roles (safe, within its permissions).\n' +
        '- Creates ~50 modern, emoji-rich channels and categories.\n' +
        '- Sets up roles and permissions for staff, support and members.\n' +
        '- Sends AUTR-style rules embeds.\n' +
        '- Installs a full ticket system with buttons and private channels.\n' +
        '- Creates staff-only and logs areas for moderation.\n' +
        '- Connects to a dedicated voice channel for 24/7 presence (muted & deafened).'
    )
    .setFooter({ text: 'Use .setup to start a full server build (Admin only).' });

  await message.channel.send({ embeds: [embed] });
}

async function handleInvite(message) {
  // İstersen buraya kendi bot ID’ni sabitleyebilirsin
  const clientId = client.user.id;
  const url = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot`;

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('Invite Me')
    .setDescription(
      'Use the link below to invite this bot with Administrator permissions (required for full setup):\n\n' +
        `[Invite Link](${url})`
    );

  await message.channel.send({ embeds: [embed] });
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

async function handleSetup(message) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return message.reply('Only administrators can run `.setup`.');
  }

  const embed = new EmbedBuilder()
    .setColor(0xff5555)
    .setTitle('Server Setup Confirmation')
    .setDescription(
      [
        'This will **DELETE** all channels and categories, and all manageable roles.',
        'Then it will create a **new Bot Support Server** structure with channels, roles, and ticket system.',
        '',
        'Are you sure you want to continue?'
      ].join('\n')
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup-confirm:yes')
      .setLabel('Yes, reset & build')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId('setup-confirm:no')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('❌')
  );

  await message.channel.send({ embeds: [embed], components: [row] });
}

/* ---------------- Setup İşlemleri ---------------- */

async function runFullSetup(guild, user, interactionForStatus) {
  try {
    // 1. Her şeyi sil
    await wipeGuild(guild, interactionForStatus);

    // 2. Rolleri oluştur
    const roles = await createRoles(guild);

    // 3. Kanal ve kategorileri oluştur
    const { channels, categories } = await createChannels(guild, roles);

    // 4. Kurallar embedleri
    await sendRulesEmbed(channels.rules);

    // 5. Ticket menüsü
    await setupTicketMenu(channels.ticketCreate);

    // 6. Bot Voice hazırlığı ve bağlanma
    await prepareBotVoice(guild, channels.botVoice);

    guildConfig.set(guild.id, {
      botVoiceChannelId: channels.botVoice.id,
      ticketCategoryId: categories.tickets.id,
      roles,
      channels
    });

    const doneEmbed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle('Setup Completed')
      .setDescription(
        'The Bot Support Server has been successfully created.\n' +
          '• Rules, channels, roles, and ticket system are now ready.\n' +
          '• The bot is connected to its dedicated voice channel (muted & deafened).'
      );

    if (interactionForStatus && !interactionForStatus.replied) {
      await interactionForStatus.followUp({ embeds: [doneEmbed] });
    } else {
      const defaultText = guild.systemChannel || channels.generalChat;
      if (defaultText) await defaultText.send({ embeds: [doneEmbed] });
    }
  } catch (err) {
    console.error('Error in runFullSetup:', err);
    if (interactionForStatus && !interactionForStatus.replied) {
      await interactionForStatus.followUp({
        content: 'An error occurred during setup. Check console logs.',
        ephemeral: true
      });
    }
  }
}

async function wipeGuild(guild, interactionForStatus) {
  const statusMsg = async (text) => {
    if (!interactionForStatus) return;
    try {
      await interactionForStatus.followUp({ content: text });
    } catch (_) {}
  };

  await statusMsg('Deleting channels and categories...');
  const channels = [...guild.channels.cache.values()];
  for (const ch of channels) {
    try {
      await ch.delete('Server rebuild by setup command');
    } catch (e) {
      console.error(`Unable to delete channel ${ch.id}:`, e.message);
    }
  }

  await statusMsg('Deleting manageable roles...');
  const roles = [...guild.roles.cache.values()];
  for (const role of roles) {
    if (role.managed) continue;
    if (role.id === guild.id) continue; // @everyone
    try {
      await role.delete('Server rebuild by setup command');
    } catch (e) {
      console.error(`Unable to delete role ${role.id}:`, e.message);
    }
  }
}

/* ---------------- Roller ---------------- */

async function createRoles(guild) {
  const makeRole = (name, options = {}) =>
    guild.roles.create({
      name,
      mentionable: options.mentionable ?? false,
      hoist: options.hoist ?? false,
      ...(options.color ? { color: options.color } : {}),
      permissions: options.permissions ?? []
    });

  const system = await makeRole('🤖 System', {
    permissions: [PermissionsBitField.Flags.Administrator],
    hoist: true
  });
  const owner = await makeRole('👑 Owner', {
    permissions: [PermissionsBitField.Flags.Administrator],
    hoist: true
  });
  const headAdmin = await makeRole('🛡 Head Admin', {
    permissions: [PermissionsBitField.Flags.Administrator],
    hoist: true
  });
  const admin = await makeRole('⚔️ Admin', {
    permissions: [
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.ManageGuild,
      PermissionsBitField.Flags.KickMembers,
      PermissionsBitField.Flags.BanMembers,
      PermissionsBitField.Flags.ManageMessages
    ],
    hoist: true
  });
  const mod = await makeRole('🔧 Moderator', {
    permissions: [
      PermissionsBitField.Flags.ManageMessages,
      PermissionsBitField.Flags.MuteMembers,
      PermissionsBitField.Flags.DeafenMembers,
      PermissionsBitField.Flags.MoveMembers,
      PermissionsBitField.Flags.ManageNicknames
    ],
    hoist: true
  });
  const support = await makeRole('🎫 Support Team', {
    permissions: [PermissionsBitField.Flags.ManageMessages],
    hoist: true
  });
  const security = await makeRole('🛡 Security', {
    permissions: [PermissionsBitField.Flags.ManageMessages],
    hoist: true
  });
  const partner = await makeRole('🤝 Partner', { color: 0x00ffea });
  const vip = await makeRole('🌟 VIP', { color: 0xffd700 });
  const booster = await makeRole('💎 Booster', { color: 0xff73fa });
  const verified = await makeRole('✅ Verified', { color: 0x00ff87 });
  const member = await makeRole('👥 Member', { color: 0xffffff });
  const bot = await makeRole('🤖 Bot', { color: 0x5865f2 });

  return {
    system,
    owner,
    headAdmin,
    admin,
    mod,
    support,
    security,
    partner,
    vip,
    booster,
    verified,
    member,
    bot
  };
}

/* ---------------- Kanallar ---------------- */

async function createChannels(guild, roles) {
  // Kategoriler
  const welcomeInfo = await guild.channels.create({
    name: '🏠 WELCOME & INFO',
    type: ChannelType.GuildCategory
  });
  const community = await guild.channels.create({
    name: '👥 COMMUNITY',
    type: ChannelType.GuildCategory
  });
  const botSupport = await guild.channels.create({
    name: '🛠 BOT SUPPORT',
    type: ChannelType.GuildCategory
  });
  const tickets = await guild.channels.create({
    name: '🎫 TICKETS',
    type: ChannelType.GuildCategory
  });
  const voiceHangouts = await guild.channels.create({
    name: '🔊 VOICE & HANGOUTS',
    type: ChannelType.GuildCategory
  });
  const staffArea = await guild.channels.create({
    name: '🔐 STAFF AREA',
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: roles.admin.id,
        allow: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: roles.headAdmin.id,
        allow: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: roles.mod.id,
        allow: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: roles.support.id,
        allow: [PermissionsBitField.Flags.ViewChannel]
      }
    ]
  });
  const logsCat = await guild.channels.create({
    name: '📊 LOGS',
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: roles.admin.id,
        allow: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: roles.headAdmin.id,
        allow: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: roles.mod.id,
        allow: [PermissionsBitField.Flags.ViewChannel]
      }
    ]
  });

  // Welcome & Info
  const rules = await guild.channels.create({
    name: '📜-rules',
    type: ChannelType.GuildText,
    parent: welcomeInfo.id
  });
  const announcements = await guild.channels.create({
    name: '📢-announcements',
    type: ChannelType.GuildText,
    parent: welcomeInfo.id
  });
  const updates = await guild.channels.create({
    name: '📰-updates',
    type: ChannelType.GuildText,
    parent: welcomeInfo.id
  });
  const faq = await guild.channels.create({
    name: '📌-faq',
    type: ChannelType.GuildText,
    parent: welcomeInfo.id
  });
  const welcomeLogs = await guild.channels.create({
    name: '📥-welcome-logs',
    type: ChannelType.GuildText,
    parent: welcomeInfo.id
  });

  // Community
  const generalChat = await guild.channels.create({
    name: '💬-general-chat',
    type: ChannelType.GuildText,
    parent: community.id
  });
  const offTopic = await guild.channels.create({
    name: '🎮-off-topic',
    type: ChannelType.GuildText,
    parent: community.id
  });
  const media = await guild.channels.create({
    name: '📷-media',
    type: ChannelType.GuildText,
    parent: community.id
  });
  const botShowcase = await guild.channels.create({
    name: '🤖-bot-showcase',
    type: ChannelType.GuildText,
    parent: community.id
  });
  const suggestions = await guild.channels.create({
    name: '🧠-suggestions',
    type: ChannelType.GuildText,
    parent: community.id
  });
  const help = await guild.channels.create({
    name: '❓-help',
    type: ChannelType.GuildText,
    parent: community.id
  });
  const partners = await guild.channels.create({
    name: '🤝-partners',
    type: ChannelType.GuildText,
    parent: community.id
  });
  const games = await guild.channels.create({
    name: '🎲-games',
    type: ChannelType.GuildText,
    parent: community.id
  });
  const topSupporters = await guild.channels.create({
    name: '🏆-top-supporters',
    type: ChannelType.GuildText,
    parent: community.id
  });

  // Bot Support
  const howToUse = await guild.channels.create({
    name: '📘-how-to-use-the-bot',
    type: ChannelType.GuildText,
    parent: botSupport.id
  });
  const changelogs = await guild.channels.create({
    name: '📂-bot-changelogs',
    type: ChannelType.GuildText,
    parent: botSupport.id
  });
  const integrations = await guild.channels.create({
    name: '🧩-integrations',
    type: ChannelType.GuildText,
    parent: botSupport.id
  });
  const bugReports = await guild.channels.create({
    name: '🐞-bug-reports',
    type: ChannelType.GuildText,
    parent: botSupport.id
  });
  const featureRequests = await guild.channels.create({
    name: '✅-feature-requests',
    type: ChannelType.GuildText,
    parent: botSupport.id
  });
  const betaTesting = await guild.channels.create({
    name: '🧪-beta-testing',
    type: ChannelType.GuildText,
    parent: botSupport.id
  });

  // Tickets
  const ticketCreate = await guild.channels.create({
    name: '🎫-ticket-create',
    type: ChannelType.GuildText,
    parent: tickets.id
  });

  // Voice & Hangouts
  const generalVoice = await guild.channels.create({
    name: '💬 General Voice',
    type: ChannelType.GuildVoice,
    parent: voiceHangouts.id
  });
  const gaming1 = await guild.channels.create({
    name: '🎮 Gaming 1',
    type: ChannelType.GuildVoice,
    parent: voiceHangouts.id
  });
  const gaming2 = await guild.channels.create({
    name: '🎮 Gaming 2',
    type: ChannelType.GuildVoice,
    parent: voiceHangouts.id
  });
  const meetingRoom = await guild.channels.create({
    name: '🎙 Meeting Room',
    type: ChannelType.GuildVoice,
    parent: voiceHangouts.id
  });
  const afk = await guild.channels.create({
    name: '🛌 AFK',
    type: ChannelType.GuildVoice,
    parent: voiceHangouts.id
  });
  const botVoice = await guild.channels.create({
    name: '🔊 Bot Voice',
    type: ChannelType.GuildVoice,
    parent: voiceHangouts.id
  });

  // Staff Area
  const staffChat = await guild.channels.create({
    name: '📁-staff-chat',
    type: ChannelType.GuildText,
    parent: staffArea.id
  });
  const modLog = await guild.channels.create({
    name: '🛡-mod-log',
    type: ChannelType.GuildText,
    parent: staffArea.id
  });
  const adminLog = await guild.channels.create({
    name: '📝-admin-log',
    type: ChannelType.GuildText,
    parent: staffArea.id
  });
  const securityAlerts = await guild.channels.create({
    name: '🚨-security-alerts',
    type: ChannelType.GuildText,
    parent: staffArea.id
  });
  const ticketLog = await guild.channels.create({
    name: '📊-ticket-log',
    type: ChannelType.GuildText,
    parent: staffArea.id
  });

  // Logs
  const joinLeaveLog = await guild.channels.create({
    name: '👤-join-leave-log',
    type: ChannelType.GuildText,
    parent: logsCat.id
  });
  const commandLog = await guild.channels.create({
    name: '🔧-command-log',
    type: ChannelType.GuildText,
    parent: logsCat.id
  });
  const messageLog = await guild.channels.create({
    name: '🧹-message-log',
    type: ChannelType.GuildText,
    parent: logsCat.id
  });
  const warningLog = await guild.channels.create({
    name: '⚠️-warning-log',
    type: ChannelType.GuildText,
    parent: logsCat.id
  });

  return {
    categories: {
      welcomeInfo,
      community,
      botSupport,
      tickets,
      voiceHangouts,
      staffArea,
      logsCat
    },
    channels: {
      rules,
      announcements,
      updates,
      faq,
      welcomeLogs,
      generalChat,
      offTopic,
      media,
      botShowcase,
      suggestions,
      help,
      partners,
      games,
      topSupporters,
      howToUse,
      changelogs,
      integrations,
      bugReports,
      featureRequests,
      betaTesting,
      ticketCreate,
      generalVoice,
      gaming1,
      gaming2,
      meetingRoom,
      afk,
      botVoice,
      staffChat,
      modLog,
      adminLog,
      securityAlerts,
      ticketLog,
      joinLeaveLog,
      commandLog,
      messageLog,
      warningLog
    },
    botVoice
  };
}

/* ---------------- Kurallar ---------------- */

async function sendRulesEmbed(rulesChannel) {
  const embed1 = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle('AUTR-like General Server Rules')
    .addFields(
      {
        name: 'General Respect Rules',
        value:
          '- No discrimination, hate speech, harassment, or threats.\n' +
          '- Be respectful and tolerant to all members.\n' +
          '- Use appropriate language in all channels.'
      },
      {
        name: 'Personal Data Security',
        value:
          '- Do not share phone numbers, addresses, passwords, or other sensitive data.\n' +
          '- Do not share others’ personal data without their explicit consent.'
      },
      {
        name: 'Profile & Name Policy',
        value:
          '- Usernames, nicknames, and profile pictures must be appropriate.\n' +
          '- No NSFW, offensive, or extremely spammy emoji names.\n' +
          '- Links in usernames are not allowed.'
      }
    );

  const embed2 = new EmbedBuilder()
    .setColor(0xffffff)
    .addFields(
      {
        name: 'Advertisement & Promotion Ban',
        value:
          '- No unsolicited advertising or promotions.\n' +
          '- Do not send server invites or ads in DMs without permission.'
      },
      {
        name: 'Religious & Political Topics',
        value:
          '- Avoid religious and political debates.\n' +
          '- No provoking, insulting, or inflammatory behavior regarding these topics.'
      },
      {
        name: 'Direct Messages Behavior',
        value:
          '- Do not spam or harass users in DMs.\n' +
          '- Do not send unwanted invitations or advertisements in DMs.'
      }
    );

  const embed3 = new EmbedBuilder()
    .setColor(0xffffff)
    .addFields(
      {
        name: 'Community Order',
        value:
          '- Follow staff instructions at all times.\n' +
          '- Do not create drama or disturb the peace of the server.\n' +
          '- Report issues to the Support or Moderation team.'
      },
      {
        name: 'Server Content & Copyright',
        value:
          '- Do not share pirated or illegal content.\n' +
          '- Respect copyrights and Discord’s Terms of Service.'
      }
    )
    .setFooter({ text: 'By staying in this server, you agree to follow all rules.' });

  await rulesChannel.send({ embeds: [embed1, embed2, embed3] });
}

/* ---------------- Ticket Sistemi ---------------- */

async function setupTicketMenu(ticketChannel) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Support Tickets')
    .setDescription(
      'Need help with the bot, found a bug, or want to discuss a partnership?\n\n' +
        'Use the buttons below to create a private ticket. Our Support Team will assist you as soon as possible.'
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket-open:general')
      .setLabel('General Support')
      .setEmoji('🛠')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('ticket-open:bug')
      .setLabel('Bug Report')
      .setEmoji('🐞')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ticket-open:partner')
      .setLabel('Partnership')
      .setEmoji('🤝')
      .setStyle(ButtonStyle.Success)
  );

  await ticketChannel.send({ embeds: [embed], components: [row] });
}

async function handleOpenTicket(interaction, type) {
  const guild = interaction.guild;
  const config = guildConfig.get(guild.id);
  const categoryId = config?.ticketCategoryId || interaction.channel.parentId;

  const existing = guild.channels.cache.find(
    (ch) =>
      ch.parentId === categoryId &&
      ch.type === ChannelType.GuildText &&
      ch.name.toLowerCase().includes(interaction.user.username.toLowerCase())
  );
  if (existing) {
    return interaction.reply({
      content: `You already have an open ticket: ${existing}`,
      ephemeral: true
    });
  }

  const ticketNameBase =
    type === 'bug' ? 'bug' : type === 'partner' ? 'partner' : 'ticket';

  const ticketChannel = await guild.channels.create({
    name: `${ticketNameBase}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
    type: ChannelType.GuildText,
    parent: categoryId,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: interaction.user.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
      }
    ]
  });

  const embed = new EmbedBuilder()
    .setColor(0x00b0f4)
    .setTitle('New Ticket')
    .setDescription(
      `Hello ${interaction.user},\n\n` +
        'Please describe your issue in detail (what happened, steps to reproduce, screenshots, etc.).\n' +
        'A member of our Support Team will respond as soon as possible.'
    )
    .addFields({ name: 'Ticket Type', value: type, inline: true });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket-close:now')
      .setLabel('Close Ticket')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Danger)
  );

  await ticketChannel.send({ content: `<@${interaction.user.id}>`, embeds: [embed], components: [row] });

  await interaction.reply({ content: `Your ticket has been created: ${ticketChannel}`, ephemeral: true });
}

async function handleCloseTicket(interaction) {
  const channel = interaction.channel;
  if (channel.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true });
  }

  await interaction.reply({ content: 'Closing ticket in 5 seconds...', ephemeral: true });
  setTimeout(async () => {
    try {
      await channel.delete('Ticket closed by button');
    } catch (e) {
      console.error('Error closing ticket:', e);
    }
  }, 5000);
}

/* ---------------- Ses Kanalı (24/7) ---------------- */

async function prepareBotVoice(guild, botVoiceChannel) {
  try {
    await connectToVoice(guild, botVoiceChannel);
    console.log(`Bot Voice channel ready and joined in guild ${guild.id} -> ${botVoiceChannel.id}`);
  } catch (e) {
    console.error('Error preparing bot voice:', e);
  }
}

async function connectToVoice(guild, voiceChannel) {
  try {
    const existing = getVoiceConnection(guild.id);
    if (existing) return existing;

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfMute: true,   // bot kendi kendini mute
      selfDeaf: true    // bot kendi kendini deaf
    });

    // Sunucu tarafı mute/deafen için:
    const me = guild.members.me;
    if (me && !me.voice.channelId) {
      // Biraz gecikme ile tekrar deneyebilirdik; burada basit bırakıyoruz
    }

    return connection;
  } catch (e) {
    console.error('Failed to join voice channel:', e);
    throw e;
  }
}

/* ---------------- Moderasyon Komutları ---------------- */

async function handleBan(message, args) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return;
  const user = message.mentions.members.first();
  if (!user) return message.reply('Please mention a user to ban.');
  const reason = args.slice(1).join(' ') || 'No reason provided';

  try {
    await user.ban({ reason });
    await message.channel.send(`🔨 Banned ${user.user.tag} | Reason: ${reason}`);
  } catch (e) {
    console.error(e);
    message.reply('I could not ban this user.');
  }
}

async function handleKick(message, args) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return;
  const user = message.mentions.members.first();
  if (!user) return message.reply('Please mention a user to kick.');
  const reason = args.slice(1).join(' ') || 'No reason provided';

  try {
    await user.kick(reason);
    await message.channel.send(`👢 Kicked ${user.user.tag} | Reason: ${reason}`);
  } catch (e) {
    console.error(e);
    message.reply('I could not kick this user.');
  }
}

async function handleClear(message, args) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
  const amount = parseInt(args[0], 10);
  if (isNaN(amount) || amount <= 0 || amount > 100) {
    return message.reply('Please provide a number between 1 and 100.');
  }

  await message.channel.bulkDelete(amount, true);
  const msg = await message.channel.send(`🧹 Deleted ${amount} messages.`);
  setTimeout(() => msg.delete().catch(() => {}), 3000);
}

/* ---------------- Login ---------------- */

client.login(TOKEN);
