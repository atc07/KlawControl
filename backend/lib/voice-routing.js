// Shared voice routing helpers used by HTTP + realtime voice paths.

const CHANNEL_KEYWORDS = {
  underwriting: 'agent:main:discord:channel:1471683763007262793',
  sdi: 'agent:main:discord:channel:1471683763007262793',
  submerit: 'agent:main:discord:channel:1471683763007262793',
  sousiq: 'agent:main:discord:channel:1471523072946475185',
  recipe: 'agent:main:discord:channel:1471523072946475185',
  meal: 'agent:main:discord:channel:1471523072946475185',
  cleanmybox: 'agent:main:discord:channel:1471523073856503993',
  klaw: 'agent:main:discord:channel:1479104379402322130',
  glasses: 'agent:main:discord:channel:1471691934295916730',
  sightreply: 'agent:main:discord:channel:1471691934295916730',
  collective: 'agent:main:discord:channel:1472822763151556761',
  yourtalks: 'agent:main:discord:channel:1473821329231843478',
  'audio digest': 'agent:main:discord:channel:1473821329231843478',
};

const CHANNEL_NAMES = {
  'agent:main:discord:channel:1471683763007262793': '#underwriting',
  'agent:main:discord:channel:1471523072946475185': '#sousiq',
  'agent:main:discord:channel:1471523073856503993': '#cleanmybox',
  'agent:main:discord:channel:1479104379402322130': '#klaw-control',
  'agent:main:discord:channel:1471691934295916730': '#ai-glasses-imessage',
  'agent:main:discord:channel:1472822763151556761': '#collective-theory',
  'agent:main:discord:channel:1473821329231843478': '#yourtalks',
  'agent:main:discord:channel:1471507451256901634': '#general',
};

function detectChannel(text) {
  const lower = String(text || '').toLowerCase();
  for (const [keyword, sessionKey] of Object.entries(CHANNEL_KEYWORDS)) {
    if (lower.includes(keyword)) {
      return { sessionKey, channelName: CHANNEL_NAMES[sessionKey] || keyword };
    }
  }
  return null;
}

function resolveTargetSession(text, explicitSession) {
  const detected = detectChannel(text);
  const sessionKey = explicitSession || detected?.sessionKey || 'agent:main:main';
  const channelName = CHANNEL_NAMES[sessionKey] || 'main';
  return {
    sessionKey,
    channelName,
    routed: !!detected,
    detected,
  };
}

module.exports = {
  CHANNEL_KEYWORDS,
  CHANNEL_NAMES,
  detectChannel,
  resolveTargetSession,
};
