import { loadEnv } from '../lib/config.mjs';
import { PocketBase } from '../lib/pocketbase.mjs';
import { resultFields, uniqueIndex } from '../lib/schema.mjs';

loadEnv();
try {
  const pb = new PocketBase();
  const path = `/collections/${encodeURIComponent(pb.collection)}`;
  const collection = await pb.request(path);
  const fields = [...collection.fields];
  for (const field of resultFields) {
    const existing = fields.find(f => f.name === field.name);
    if (existing && existing.type !== field.type) throw new Error(`Field ${field.name} has an incompatible type.`);
    if (!existing) fields.push(field);
  }
  const indexes = [...collection.indexes];
  const index = uniqueIndex(collection.name);
  if (!indexes.some(existing => existing.includes(`idx_${collection.name}_submission`))) indexes.push(index);
  await pb.request(path, { method: 'PATCH', body: JSON.stringify({ fields, indexes }) });
  console.log(`Prepared collection ${pb.collection}. Existing fields, records, and API rules were preserved.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
