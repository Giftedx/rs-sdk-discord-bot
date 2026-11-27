// discord.js implementations of the small channel interfaces. No logic here beyond the mapping.
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ThreadAutoArchiveDuration,
  type MessageCreateOptions,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import type { LogThread, LogThreadHost } from './adventure-log';
import type { PostChannel } from './posts';
import type { CardChannel, CardMessage } from './status-card';

const NO_PINGS = { parse: [] as [] };

function cardPayload(msg: CardMessage) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    msg.buttons.map((b) =>
      new ButtonBuilder()
        .setCustomId(b.id)
        .setLabel(b.label)
        .setStyle(b.danger ? ButtonStyle.Danger : ButtonStyle.Secondary),
    ),
  );
  const files = msg.frame ? [new AttachmentBuilder(Buffer.from(msg.frame), { name: 'frame.png' })] : [];
  return { content: msg.content, components: [row], files, allowedMentions: NO_PINGS };
}

export function cardChannel(channel: TextChannel): CardChannel {
  return {
    async fetchPinned() {
      const own = channel.client.user?.id;
      const pins = await channel.messages.fetchPinned();
      return [...pins.values()].filter((m) => m.author.id === own).map((m) => ({ id: m.id, content: m.content }));
    },
    async send(msg) {
      const m = await channel.send(cardPayload(msg) as MessageCreateOptions);
      return m.id;
    },
    async edit(id, msg) {
      // attachments: [] removes the old frame, so only the new one stays.
      await channel.messages.edit(id, { ...cardPayload(msg), attachments: [] });
    },
    async pin(id) {
      await channel.messages.pin(id);
    },
  };
}

function logThread(t: ThreadChannel): LogThread {
  return {
    async send(content) {
      await t.send({ content, allowedMentions: NO_PINGS });
    },
  };
}

export function logThreadHost(channel: TextChannel): LogThreadHost {
  return {
    async findThread(name) {
      const active = await channel.threads.fetchActive();
      let t = active.threads.find((x) => x.name === name && x.parentId === channel.id);
      if (!t) {
        const archived = await channel.threads.fetchArchived({ type: 'public' });
        t = archived.threads.find((x) => x.name === name);
      }
      return t ? logThread(t) : null;
    },
    async createThread(name) {
      const t = await channel.threads.create({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
      return logThread(t);
    },
  };
}

export function postChannel(channel: TextChannel): PostChannel {
  return {
    async send(content, png) {
      const files = png ? [new AttachmentBuilder(Buffer.from(png), { name: 'card.png' })] : [];
      await channel.send({ content, files, allowedMentions: NO_PINGS });
    },
  };
}
