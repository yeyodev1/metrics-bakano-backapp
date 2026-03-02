import bcrypt from "bcryptjs";
import models from "../models";

export const seedSuperadmin = async () => {
  try {
    const email = "testing@bakano.ec";
    const passwordString = "123456789";

    const existingUser = await models.users.findOne({ email }).lean();

    if (!existingUser) {
      const hashedPassword = await bcrypt.hash(passwordString, 10);

      await models.users.create({
        email,
        password: hashedPassword,
        role: "superadmin",
        isActive: true,
      });

      console.log("Superadmin seeded successfully.");
    }
  } catch (error) {
    console.error("Error seeding superadmin:", error);
  }
};
