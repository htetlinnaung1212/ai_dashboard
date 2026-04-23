const bcrypt = require("bcrypt");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function createUsers() {
  try {
    const username = "superadmin";
    const password = "admin123";

    const hash = await bcrypt.hash(password, 10);

    // Check if user already exists
    const { data: existingUser } = await supabase
      .from("users")
      .select("id")
      .eq("username", username)
      .maybeSingle();

    if (existingUser) {
      console.log("User already exists");
      process.exit();
    }

    const { error } = await supabase
      .from("users")
      .insert({
        username: username,
        password_hash: hash,
        role: "super-admin",
        is_active: true
      });

    if (error) {
      console.error("Insert error:", error);
      process.exit(1);
    }

    console.log("Superadmin user created successfully");
    process.exit();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

createUsers();