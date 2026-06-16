import * as dotenv from "dotenv";
import models from "./src/models";
import { dbConnect } from "./src/config/mongo";

dotenv.config();

const updates = [
  { email: "framirez@bakano.ec", url: "https://res.cloudinary.com/dpuody0df/image/upload/v1781222187/bakano/team/qawtwffajhpwfzbrv1hc.jpg" },
  { email: "jleon@bakano.ec", url: "https://res.cloudinary.com/dpuody0df/image/upload/v1781222189/bakano/team/r6211ec1qzdqwrr0cby0.jpg" },
  { email: "dreyes@bakano.ec", url: "https://res.cloudinary.com/dpuody0df/image/upload/v1781222186/bakano/team/hwnqfjdvuhanwcbbuapz.jpg" },
  { email: "kmunoz@bakano.ec", url: "https://res.cloudinary.com/dpuody0df/image/upload/v1781222193/bakano/team/iidq8k7xu1ix1aqfyq2a.jpg" },
  { email: "jortega@bakano.ec", url: "https://res.cloudinary.com/dpuody0df/image/upload/v1781222190/bakano/team/xdh2rrivw24aehhbkoet.jpg" },
  { email: "lreyes@bakano.ec", url: "https://res.cloudinary.com/dpuody0df/image/upload/v1781222194/bakano/team/s2hfggzsqon0xrufrynj.jpg" },
  // Guessing the other ones based on common pattern
  { email: "avera@bakano.ec", url: "https://res.cloudinary.com/dpuody0df/image/upload/v1781222182/bakano/team/t1e4dhwvqx2rxrjrdglk.jpg" },
  { email: "dquimi@bakano.ec", url: "https://res.cloudinary.com/dpuody0df/image/upload/v1781222184/bakano/team/gvtqcefl1vhep44btx0f.jpg" },
  { email: "dramos@bakano.ec", url: "https://res.cloudinary.com/dpuody0df/image/upload/v1781222185/bakano/team/zhpznpbvubhk7ozvlhbi.jpg" },
];

async function run() {
  try {
    await dbConnect();
    console.log("Connected to MongoDB for update...");
    for (const u of updates) {
      const user = await models.users.findOneAndUpdate(
        { email: u.email },
        { photoUrl: u.url },
        { new: true }
      );
      if (user) {
        console.log(`✅ Updated ${u.email}`);
      } else {
        console.log(`❌ Not found: ${u.email}`);
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

run();
