const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
require("dotenv").config();

const User = require("./models/User");

async function createUsers() {
    await mongoose.connect(process.env.MONGO_URI);

    const password = "admin123"; // change later

    const hash = await bcrypt.hash(password, 10);

    await User.create([
        {
            username: "superadmin",
            passwordHash: hash,
            role: "super-admin"
        },
       
    ]);

    console.log("Users created");
    process.exit();
}

createUsers();