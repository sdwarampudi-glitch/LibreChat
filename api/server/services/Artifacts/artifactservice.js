const axios = require('axios');

async function generateArtifact(output) {
  try {
    const parsed = typeof output === 'string' ? JSON.parse(output) : output;

    if (!parsed?.type || !parsed?.sections) return null;

    const res = await axios.post(
      `${process.env.ARTIFACT_SERVICE_URL}/generate`,
      parsed
    );

    return {
      url: res.data.downloadUrl,
      type: parsed.type,
    };
  } catch (e) {
    return null;
  }
}

module.exports = { generateArtifact };
