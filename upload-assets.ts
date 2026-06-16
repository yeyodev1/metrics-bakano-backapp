import mongoose from "mongoose";
import * as dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs";
import path from "path";
import models from "./src/models";
import { dbConnect } from "./src/config/mongo";

dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const frontAppPath = path.resolve(__dirname, "../ads-bakano-clients-frontapp");
const teamPath = path.join(frontAppPath, "team");
const videosPath = path.join(frontAppPath, "videospresentacion");

async function run() {
  try {
    await dbConnect();
    console.log("Connected to DB");

    // Upload photos
    if (fs.existsSync(teamPath)) {
      const photos = fs.readdirSync(teamPath);
      for (const photo of photos) {
        if (!photo.match(/\.(jpg|jpeg|png)$/i)) continue;
        console.log(`Uploading photo: ${photo}...`);
        
        const res = await cloudinary.uploader.upload(path.join(teamPath, photo), {
          folder: "bakano/team",
        });

        const identifier = path.basename(photo, path.extname(photo)).toLowerCase();
        
        // Find internal user matching the identifier
        const user = await models.users.findOne({
          isInternal: true,
          $or: [
            { email: new RegExp(identifier, "i") },
            { name: new RegExp(identifier, "i") }
          ]
        });

        if (user) {
          user.photoUrl = res.secure_url;
          await user.save();
          console.log(`✅ Updated user ${user.name} (${user.email}) with photo: ${res.secure_url}`);
        } else {
          console.log(`⚠️ No internal user found for identifier: ${identifier}. URL: ${res.secure_url}`);
        }
      }
    }

    // Upload videos
    if (fs.existsSync(videosPath)) {
      const videos = fs.readdirSync(videosPath);
      for (const video of videos) {
        if (!video.match(/\.(mp4|mov)$/i)) continue;
        console.log(`Uploading video: ${video}... (this might take a while)`);
        
        const res = await cloudinary.uploader.upload(path.join(videosPath, video), {
          resource_type: "video",
          folder: "bakano/squads",
        });
        
        console.log(`✅ Uploaded video ${video} -> URL: ${res.secure_url}`);
      }
    }

    console.log("Done.");
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await mongoose.disconnect();
  }
}

run();
