import mongoose from 'mongoose';
import { WorkspaceModel } from './src/models/workspace.model';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '.env') });

async function run() {
  await mongoose.connect(process.env.DB_URI as string);
  console.log('Connected to MongoDB');

  const workspaceId = '69c5a0ccb183cfc9f80cc6da';
  const workspace = await WorkspaceModel.findById(workspaceId);
  
  if (!workspace) {
    console.log('Workspace not found');
    process.exit(1);
  }

  // Reset onboarding status
  workspace.onboardingStatus = {
    videoGenesisAccepted: false,
    contractSubmitted: false,
    meetingScheduled: false
  };

  // Unset contract data
  workspace.contractData = undefined;

  await workspace.save();
  
  console.log('Onboarding successfully reset for workspace:', workspace.name);
  process.exit(0);
}

run().catch(console.error);
