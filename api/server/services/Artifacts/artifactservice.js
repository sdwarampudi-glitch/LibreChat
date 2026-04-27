const path = require('path');

/**
 * TEMP ARTIFACT SERVICE (WORKING BASELINE)
 * Replace later with real PPT/DOC/PDF generator (Railway service)
 */

async function generateArtifact({ text, conversationId }) {
  try {
    if (!text) return null;

    // simple rule-based detection
    let type = 'docx';

    if (text.toLowerCase().includes('powerpoint') || text.toLowerCase().includes('ppt')) {
      type = 'pptx';
    }

    if (text.toLowerCase().includes('pdf') || text.toLowerCase().includes('report')) {
      type = 'pdf';
    }

    // MOCK URL (replace with real Railway service later)
    const fileId = `${conversationId}-${Date.now()}`;

    return {
      type,
      url: `https://your-artifact-service.local/files/${fileId}.${type}`,
      status: 'mock',
    };
  } catch (err) {
    console.error('[Artifact Service Error]', err);
    return null;
  }
}

module.exports = {
  generateArtifact,
};
