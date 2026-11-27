// discord.js implementations of the small channel interfaces. No logic here beyond the mapping.
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type MessageCreateOptions,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type TextChannel,
  type ThreadChannel,
  type User,
} from 'discord.js';
import type { LogThread, LogThreadHost } from './adventure-log';
import type { PostChannel } from './posts';
import type { ReactionInput } from './queue-votes';
import type { CardChannel, CardMessage } from './status-card';

const NO_PINGS = { parse: [] as [] };

function silentFlags(silent: boolean | undefined) {
  return silent ? { flags: MessageFlags.SuppressNotifications as const } : {};
}

function pngFiles(pngs: (Uint8Array | undefined)[], base: string): AttachmentBuilder[] {
  const list = pngs.filter((p): p is Uint8Array => p !== undefined);
  return list.map((p, i) => new AttachmentBuilder(Buffer.from(p), { name: i === 0 ? `${base}.png` : `${base}-${i + 1}.png` }));
}

function cardPayload(msg: CardMessage) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    msg.buttons.map((b) =>
      b.url
        ? new ButtonBuilder().setURL(b.url).setLabel(b.label).setStyle(ButtonStyle.Link)
        : new ButtonBuilder()
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
      const pins = await channel.messages.fetchPins();
      return pins.items.map((p) => p.message).filter((m) => m.author.id === own).map((m) => ({ id: m.id, content: m.content }));
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
    async send(content, opts) {
      const m = await t.send({ content, files: pngFiles([opts?.png], 'frame'), allowedMentions: NO_PINGS, ...silentFlags(opts?.silent) });
      return m.id;
    },
    async edit(id, content) {
      await t.messages.edit(id, { content, allowedMentions: NO_PINGS });
    },
  };
}

export function logThreadHost(channel: TextChannel): LogThreadHost {
  return {
    async findThread(name) {
      const active = await channel.threads.fetchActive();
      let t = active.threads.find((x) => x.name === name && x.parentId === channel.id);
      if (!t) {
        // The archived threads come in pages. Read up to 10 pages of 100.
        let before: ThreadChannel | undefined;
        for (let page = 0; page < 10 && !t; page++) {
          const archived = await channel.threads.fetchArchived({ type: 'public', limit: 100, ...(before ? { before } : {}) });
          t = archived.threads.find((x) => x.name === name);
          if (!archived.hasMore || archived.threads.size === 0) break;
          before = archived.threads.last();
        }
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
    async send(content, png, opts) {
      const files = pngFiles([png, ...(opts?.extra ?? [])], 'card');
      await channel.send({ content, files, allowedMentions: NO_PINGS, ...silentFlags(opts?.silent) });
    },
  };
}

/** Maps a messageReactionAdd event to the input of QueueVotes.onReaction. Fetches partials; null when that fails. */
export async function reactionInput(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<ReactionInput | null> {
  try {
    const r = reaction.partial ? await reaction.fetch() : reaction;
    const u = user.partial ? await user.fetch() : user;
    return { messageId: r.message.id, userId: u.id, userIsBot: u.bot, emoji: r.emoji.name };
  } catch {
    return null;
  }
}
