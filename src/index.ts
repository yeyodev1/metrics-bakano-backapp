import "dotenv/config";
import { dbConnect } from "./config/mongo";
import { createApp } from "./app";
import { seedSuperadmin } from "./utils/seeders";
import { initBillingCrons } from "./crons/billing.cron";
import { initBrandProfileCrons } from "./crons/brandProfile.cron";


async function main() {
  const port = process.env.PORT || 8100;
  await dbConnect();
  await seedSuperadmin();
  initBillingCrons();
  initBrandProfileCrons();

  const { app, server } = createApp();

  server.timeout = 10 * 60 * 1000;

  server.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

main();
