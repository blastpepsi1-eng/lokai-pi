import { complete, getModel } from "@blastpepsi1-eng/lokai-ai";

const model = getModel("google", "gemini-2.5-flash");
console.log(model.id, typeof complete);
