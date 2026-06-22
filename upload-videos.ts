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
  if (!process.env.DB_URI) {
    console.error("DB_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(process.env.DB_URI);
  console.log("Connected to MongoDB.");

  const videoAlfaLoboPath = path.resolve('../ads-bakano-clients-frontapp/videospresentacion/equipo-alfa-lobo.mp4');
  const videoDinamiaPath = path.resolve('../ads-bakano-clients-frontapp/videospresentacion/equipo-dinamita-jean-y-karen.MP4');

  try {
    console.log("Uploading Alfa Lobo video...");
    const alfaLoboRes = await cloudinary.uploader.upload(videoAlfaLoboPath, { resource_type: 'video', folder: 'bakano_teams' });
    console.log("Alfa Lobo uploaded:", alfaLoboRes.secure_url);

    console.log("Uploading Dinamia video...");
    const dinamiaRes = await cloudinary.uploader.upload_large(videoDinamiaPath, { resource_type: 'video', folder: 'bakano_teams' });
    console.log("Dinamia uploaded:", dinamiaRes.secure_url);

    console.log("Updating users...");

    const updatedAlfa = await UserModel.updateMany(
      { name: { $regex: 'fernando|javier', $options: 'i' }, isInternal: true },
      { $set: { presentationVideoUrl: alfaLoboRes.secure_url } }
    );
    console.log("Alfa Lobo members updated:", updatedAlfa.modifiedCount);

    const updatedDinamia = await UserModel.updateMany(
      { name: { $regex: 'jean|karen', $options: 'i' }, isInternal: true },
      { $set: { presentationVideoUrl: dinamiaRes.secure_url } }
    );
    console.log("Dinamia members updated:", updatedDinamia.modifiedCount);

    console.log("Users updated successfully.");
  } catch (error) {
    console.error("Error during upload/update:", error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

run();
