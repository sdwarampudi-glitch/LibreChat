const logger = require('@librechat/data-schemas').logger;

/**
 * SIMPLE ARTIFACT SERVICE (SAFE FALLBACK)
 * Prevents crashes + returns mock file links
 */

async function generateArtifact({ text, conversationId }) {
  try {
    if (!text) return null;

    let type = 'docx';

    const lower = text.toLowerCase();

    if (lower.includes('ppt') || lower.includes('powerpoint')) {
      type = 'pptx';
    } else if (lower.includes('pdf') || lower.includes('report')) {
      type = 'pdf';
    }

    const fileId = `${conversationId}-${Date.now()}`;

    return {
      type,
      url: `https://example.com/artifacts/${fileId}.${type}`,
      status: 'mock',
    };
  } catch (err) {
    logger?.warn?.('[artifactService] error', err);
    return null;
  }
}

module.exports = {
  generateArtifact,
};
