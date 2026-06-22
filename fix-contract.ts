import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import { WorkspaceModel } from './src/models/workspace.model';
import { onboardingService } from './src/services/onboarding.service';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '.env') });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function run() {
  await mongoose.connect(process.env.DB_URI as string);
  console.log('Connected to MongoDB');

  const workspaceId = '69c5a0ccb183cfc9f80cc6da';
  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace || !workspace.contractData) {
    console.log('No workspace or contract data');
    process.exit(1);
  }

  const contractData = workspace.contractData;
  console.log('Generating PDF...');
  const pdfBuffer = await onboardingService.generateContractPDF(contractData);

  console.log('Uploading to Cloudinary as image...');
  const cloudinaryResult = await new Promise<{ url: string; public_id: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "contracts", resource_type: "image", format: "pdf" },
      (error, result) => {
        if (error || !result) return reject(error);
        resolve({ url: result.url, public_id: result.public_id });
      }
    );
    stream.end(pdfBuffer);
  });

  console.log('New URL:', cloudinaryResult.url);
  workspace.contractData.pdfUrl = cloudinaryResult.url;
  workspace.markModified('contractData');
  await workspace.save();
  console.log('Done!');
  process.exit(0);
}

run().catch(console.error);
