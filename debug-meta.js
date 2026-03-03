const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();

const DB_URI = process.env.DB_URI || 'mongodb+srv://dreyes_db_user:5ZHHqnOmNE5fHpe7@cluster0.l4ophuv.mongodb.net/?appName=Cluster0';

const workspaceSchema = new mongoose.Schema({
  name: String,
  metaAds: {
    accessToken: String,
    pageAccessToken: String,
    pageId: String
  }
}, { strict: false });

const Workspace = mongoose.model('Workspace', workspaceSchema, 'workspaces');

async function checkTokens() {
  try {
    await mongoose.connect(DB_URI);
    console.log('Connected to DB');

    const workspaces = await Workspace.find({ 'metaAds.pageId': { $exists: true } });
    console.log(`Found ${workspaces.length} workspaces with Meta integration`);

    for (const ws of workspaces) {
      console.log(`\n--- Workspace: ${ws.name} ---`);
      const { accessToken, pageAccessToken, pageId } = ws.metaAds;

      let tokenToUse = pageAccessToken || accessToken;

      // Check user token permissions
      if (accessToken) {
        try {
          const permRes = await axios.get(`https://graph.facebook.com/v22.0/me/permissions`, {
            params: { access_token: accessToken }
          });
          console.log('User Token Permissions:', permRes.data.data.map(p => `${p.permission}: ${p.status}`).join(', '));
        } catch (e) {
          console.error('Error fetching user permissions:', e.response?.data || e.message);
        }
      }

      // Check page token permissions
      if (pageAccessToken) {
        try {
          const pagePerm = await axios.get(`https://graph.facebook.com/v22.0/me/permissions`, {
            params: { access_token: pageAccessToken }
          });
          console.log('Page Token Permissions:', pagePerm.data.data.map(p => `${p.permission}: ${p.status}`).join(', '));
        } catch (e) {
          console.error('Error fetching page permissions:', e.response?.data || e.message);
        }
      }

      // Try fetching page info
      try {
        console.log(`Fetching page info for page ${pageId}...`);
        const infoRes = await axios.get(`https://graph.facebook.com/v22.0/${pageId}`, {
          params: { access_token: tokenToUse, fields: 'name,fan_count' }
        });
        console.log('Page Info Success:', infoRes.data);
      } catch (e) {
        console.error('Page Info Error:', JSON.stringify(e.response?.data) || e.message);
      }

      // Try fetching posts
      try {
        console.log(`Fetching published posts for page ${pageId}...`);
        const postsRes = await axios.get(`https://graph.facebook.com/v22.0/${pageId}/published_posts`, {
          params: { access_token: tokenToUse, fields: 'message', limit: 1 }
        });
        console.log('Published Posts Success, count:', postsRes.data.data.length);
      } catch (e) {
        console.error('Published Posts Error:', JSON.stringify(e.response?.data) || e.message);
      }
    }

  } catch (err) {
    console.error('Script error:', err);
  } finally {
    mongoose.disconnect();
  }
}

checkTokens();
