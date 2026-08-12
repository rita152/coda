import { environmentName } from "../src/settings.js";

if (environmentName() !== "production") throw new Error("expected the production environment");
