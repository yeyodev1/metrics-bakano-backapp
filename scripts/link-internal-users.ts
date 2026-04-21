import "dotenv/config";
import mongoose from "mongoose";

const DB_URI = process.env.DB_URI!;

const SKIP = ["lreyes@bakano.ec"];

const UserSchema = new mongoose.Schema({
  email: String,
  isInternal: Boolean,
  workspaces: [
    {
      workspaceId: mongoose.Schema.Types.ObjectId,
      role: String,
    },
  ],
});

const WorkspaceSchema = new mongoose.Schema({});

const User = mongoose.model("User", UserSchema);
const Workspace = mongoose.model("Workspace", WorkspaceSchema);

async function run() {
  await mongoose.connect(DB_URI);
  console.log("Connected:", mongoose.connection.host);

  const [bakanoUsers, allWorkspaces] = await Promise.all([
    User.find({ email: /@bakano\.ec$/i }),
    Workspace.find({}, "_id"),
  ]);

  const allWsIds = allWorkspaces.map((w) => w._id.toString());
  console.log(`Workspaces: ${allWsIds.length} | Bakano users: ${bakanoUsers.length}`);

  for (const user of bakanoUsers) {
    if (SKIP.includes(user.email!)) {
      console.log(`  SKIP: ${user.email}`);
      continue;
    }

    const existingIds = new Set(
      (user.workspaces ?? []).map((w: any) => w.workspaceId.toString())
    );

    const toAdd = allWorkspaces
      .filter((w) => !existingIds.has(w._id.toString()))
      .map((w) => ({ workspaceId: w._id, role: "colaborador" }));

    await User.updateOne(
      { _id: user._id },
      {
        $set: { isInternal: true },
        ...(toAdd.length > 0 && { $push: { workspaces: { $each: toAdd } } }),
      }
    );

    console.log(
      `  OK: ${user.email} — added ${toAdd.length} workspaces (had ${existingIds.size})`
    );
  }

  console.log("Done.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
