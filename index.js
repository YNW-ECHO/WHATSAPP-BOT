require('dotenv').config();

const logger = require('./src/logger');
const { config } = require('./src/config');
const { startServer } = require('./src/server');
const { startBot } = require('./src/bot');

process.on('unhandledRejection', (err) => logger.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => logger.error('uncaughtException:', err));

if (!config.openaiKey && !config.anthropicKey) {
  logger.warn('⚠️  No AI key set (GROQ_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY). Auto-replies stay off until you add one.');
}

startServer();
startBot().catch((e) => {
  logger.error('Fatal error starting bot:', e);
  process.exit(1);
});