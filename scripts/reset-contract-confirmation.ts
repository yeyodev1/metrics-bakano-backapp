import "dotenv/config";
import mongoose from "mongoose";

const DB_URI = process.env.DB_URI!;
const EMAIL = "diegorele13@gmail.com";
const WORKSPACE_ID = "69c5a0ccb183cfc9f80cc6da";

async function run() {
  await mongoose.connect(DB_URI);
  console.log("Connected:", mongoose.connection.host);
  const db = mongoose.connection.db;

  // Search all workspaces for this email in any field
  const allWs = await db.collection("workspaces").find({}).toArray();

  const matches = allWs.filter((ws: any) => {
    if (ws._id.toString() === WORKSPACE_ID) return true;
    if (ws.ownerId?.toString() === "69c5a0f49987585fd140b56d") return true;
    if (ws.members?.some((m: any) => m.email === EMAIL)) return true;
    if (ws.contractData?.email === EMAIL) return true;
    return false;
  });

  console.log("Total workspaces:", allWs.length);
  console.log("Matches for", EMAIL + ":", matches.length);

  for (const ws of matches) {
    console.log("\nWorkspace:", (ws as any)._id.toString(), "-", ws.name);
    console.log("  contractData?.email:", (ws as any).contractData?.email);
    console.log("  onboardingStatus:", JSON.stringify((ws as any).onboardingStatus));

    await db.collection("workspaces").updateOne(
      { _id: (ws as any)._id },
      {
        $set: {
          "onboardingStatus.contractSubmitted": false,
          "onboardingStatus.meetingScheduled": false,
          contractData: null,
        },
      }
    );

    const updated = await db.collection("workspaces").findOne({ _id: (ws as any)._id });
    console.log("  After - contractSubmitted:", updated?.onboardingStatus?.contractSubmitted);
    console.log("  After - meetingScheduled:", updated?.onboardingStatus?.meetingScheduled);
    console.log("  After - contractData:", updated?.contractData ? "exists" : "null");
    console.log("  Reset COMPLETE");
  }

  if (matches.length === 0) {
    // Try finding by contractData.email specifically
    const byContract = await db.collection("workspaces").find({ "contractData.email": EMAIL }).toArray();
    console.log("\nBy contractData.email search:", byContract.length);
    for (const ws of byContract) {
      console.log("  WS:", (ws as any)._id.toString(), ws.name);
    }
  }

  console.log("\nDone.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});