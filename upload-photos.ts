import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import { UserModel } from './src/models/user.model';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function run() {
  await mongoose.connect(process.env.DB_URI as string);
  console.log('Connected to MongoDB.');
  
  const teamDir = path.resolve('../ads-bakano-clients-frontapp/team');
  const files = fs.readdirSync(teamDir);
  
  for (const file of files) {
    if (!file.match(/\.(jpg|jpeg|png)$/i)) continue;
    const filePath = path.join(teamDir, file);
    console.log(`Uploading ${file}...`);
    
    try {
      const res = await cloudinary.uploader.upload(filePath, { folder: 'bakano_team_photos' });
      const nameKey = file.split('.')[0].toLowerCase();
      
      // Match name fuzzily
      // Examples: arianavera -> ariana vera
      // javieroleon -> javier leon
      let regexStr = nameKey;
      if (nameKey === 'ferchoramirez') regexStr = 'fernando|fercho';
      if (nameKey === 'javieroleon') regexStr = 'javier';
      if (nameKey === 'arianavera') regexStr = 'ariana';
      if (nameKey === 'denissequimi') regexStr = 'denisse';
      if (nameKey === 'diegoramos') regexStr = 'diego.*ramos';
      if (nameKey === 'diegoreyes') regexStr = 'diego.*reyes';
      if (nameKey === 'genesis') regexStr = 'genesis';
      if (nameKey === 'jeanortega') regexStr = 'jean';
      if (nameKey === 'joel') regexStr = 'joel';
      if (nameKey === 'judaiza') regexStr = 'jud'; // Maybe Judaiza
      if (nameKey === 'karenmunoz') regexStr = 'karen';
      if (nameKey === 'luisreyes') regexStr = 'luis';
      
      const updateRes = await UserModel.updateMany(
        { name: { $regex: regexStr, $options: 'i' }, isInternal: true },
        { $set: { photoUrl: res.secure_url } }
      );
      console.log(`  Updated ${updateRes.modifiedCount} users for ${file}`);
    } catch (e) {
      console.error(`Error uploading ${file}:`, e);
    }
  }
  
  await mongoose.disconnect();
}
run();
