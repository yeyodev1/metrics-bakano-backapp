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

async function checkWorkspace() {
  try {
    await mongoose.connect(DB_URI);

    // Check specific workspace
    const ws = await Workspace.findById('69a5e54a15be7cf6d45b3cf0');
    if (!ws) {
      console.log('Workspace not found');
      return;
    }

    console.log(`\n--- Workspace: ${ws.name} ---`);
    console.log(`metaAds:`, ws.metaAds);

    const { accessToken, pageAccessToken, pageId } = ws.metaAds;

    if (accessToken) {
      try {
        const permRes = await axios.get(`https://graph.facebook.com/v22.0/me/permissions`, {
          params: { access_token: accessToken }
        });
        console.log('User Token Permissions:', permRes.data.data.map(p => `${p.permission}: ${p.status}`).join(', '));
      } catch (e) {
        console.error('Error fetching user permissions:', JSON.stringify(e.response?.data) || e.message);
      }

      // Try to get page access token from user token
      try {
        console.log('\nTesting DB pageAccessToken directly...');
        try {
          const directPosts = await axios.get(`https://graph.facebook.com/v22.0/${pageId}/published_posts`, {
            params: { access_token: pageAccessToken, fields: "message,created_time,permalink_url,full_picture,shares,comments.summary(total_count),likes.summary(total_count)", limit: 5 }
          });
          console.log('SUCCESS with DB pageAccessToken!', directPosts.data.data.length);
        } catch (e) {
          console.error('ERROR with DB pageAccessToken:', e.response?.data?.error?.message || e.message);
        }

        console.log('\nTrying to fetch fresh page_access_token using user token...');
        const tokenCheck = await axios.get(`https://graph.facebook.com/v22.0/${pageId}`, {
          params: {
            access_token: accessToken,
            fields: "name,access_token"
          }
        });
        console.log('Page token response:', tokenCheck.data);

        if (tokenCheck.data.access_token) {
          // test the fetched page token!
          try {
            console.log(`Testing fetched page token for posts...`);
            const postsRes = await axios.get(`https://graph.facebook.com/v22.0/${pageId}/published_posts`, {
              params: { access_token: tokenCheck.data.access_token, fields: 'message', limit: 1 }
            });
            console.log('SUCCESS! count:', postsRes.data.data.length);
          } catch (e) {
            console.error('POSTS ERROR with fetched page token:', JSON.stringify(e.response?.data));
          }
        }
      } catch (e) {
        console.error('Error fetching page access token:', JSON.stringify(e.response?.data) || e.message);
      }

    }

  } catch (err) {
    console.error('Script error:', err);
  } finally {
    mongoose.disconnect();
  }
}

checkWorkspace();
