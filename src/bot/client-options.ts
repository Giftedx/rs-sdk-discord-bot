// Discord.js client options: bounded caches and sweepers so long-running bot sessions do not
// accumulate unbounded messages, reactions, users, members, or unused guild sub-caches in RAM.
import { GatewayIntentBits, Options, Partials, type ClientOptions } from 'discord.js';

export const DISCORD_CACHE_LIMITS = {
  MessageManager: 50,
  ReactionManager: 20,
  ReactionUserManager: 0,
  UserManager: 100,
  GuildMemberManager: {
    maxSize: 100,
    keepOverLimit: (member: { id: string; client: { user: { id: string } | null } }) =>
      member.id === member.client.user?.id,
  },
  PresenceManager: 0,
  VoiceStateManager: 0,
  StageInstanceManager: 0,
  GuildEmojiManager: 0,
  GuildStickerManager: 0,
  GuildBanManager: 0,
  GuildInviteManager: 0,
  GuildScheduledEventManager: 0,
  ThreadMemberManager: 0,
  AutoModerationRuleManager: 0,
  EntitlementManager: 0,
  PollManager: 0,
  PollAnswerManager: 0,
} as const;

export const DISCORD_SWEEPERS: NonNullable<ClientOptions['sweepers']> = {
  ...Options.DefaultSweeperSettings,
  messages: {
    interval: 300,
    lifetime: 900,
  },
  reactions: {
    interval: 300,
    filter: () => () => true,
  },
  users: {
    interval: 3_600,
    filter: () => user => user.id !== user.client.user?.id,
  },
};

export function discordClientOptions(content: boolean): ClientOptions {
  return {
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      ...(content ? [GatewayIntentBits.MessageContent] : []),
    ],
    // Reactions on messages from before the start arrive as partials (queue votes).
    partials: [Partials.Message, Partials.Reaction, Partials.User],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      ...DISCORD_CACHE_LIMITS,
    }),
    sweepers: DISCORD_SWEEPERS,
  };
}
