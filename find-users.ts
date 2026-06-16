import mongoose from 'mongoose';
import { UserModel } from './src/models/user.model';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI as string);
  const users = await UserModel.find({ name: { $regex: 'fernando|javier|jean|karen', $options: 'i' } });
  console.log(users.map(u => ({ id: u._id, name: u.name, email: u.email })));
  process.exit(0);
}
run();
