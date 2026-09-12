require('dotenv').config();

const logger = require('./src/logger');
const { config } = require('./src/config');
const { startServer } = require('./src/server');
const { startBot } = require('./src/bot');

process.on('unhandledRejection', (err) => logger.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => logger.error('uncaughtException:', err));

const hasAiKey =
  (config.aiProvider === 'groq' && config.groqKey) ||
  (config.aiProvider === 'gemini' && config.geminiKey) ||
  (config.aiProvider === 'anthropic' && config.anthropicKey) ||
  (config.aiProvider !== 'groq' && config.aiProvider !== 'gemini' && config.aiProvider !== 'anthropic' && config.openaiKey);

if (!hasAiKey) {
  logger.warn(`⚠️  No AI key set for provider "${config.aiProvider}". Auto-replies stay off until you add one.`);
}

startServer();
startBot().catch((e) => {
  logger.error('Fatal error starting bot:', e);
  process.exit(1);
});