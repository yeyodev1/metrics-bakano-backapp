import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import { UserModel } from './src/models/user.model';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function run() {
  await mongoose.connect(process.env.DB_URI as string);
  const videoPath = path.resolve('../ads-bakano-clients-frontapp/videospresentacion/equipo-dinamita-jean-y-karen.MP4');
  console.log("Uploading Dinamia...");
  
  cloudinary.uploader.upload_large(videoPath, { resource_type: 'video', folder: 'bakano_teams' }, async (error, result) => {
    if (error) {
      console.error("Upload error:", error);
    } else {
      console.log("Uploaded successfully:", result?.secure_url);
      await UserModel.updateMany(
        { name: { $regex: 'jean|karen', $options: 'i' }, isInternal: true },
        { $set: { presentationVideoUrl: result?.secure_url } }
      );
      console.log("Users updated.");
    }
    await mongoose.disconnect();
    process.exit(0);
  });
}
run();
