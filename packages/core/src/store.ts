import { readFile, writeFile } from "node:fs/promises";
import { addressKey, type Address, type Entity, type Label, type Tag } from "./types.ts";

export interface LabelStore {
  getLabel(address: Address): Promise<Label | null>;
  getTags(address: Address): Promise<Tag[]>;
  getEntity(address: Address): Promise<Entity | null>;
  addLabel(label: Label): Promise<void>;
  addTag(tag: Tag): Promise<void>;
  addEntity(entity: Entity): Promise<void>;
}

interface StoreFile {
  labels: Label[];
  tags: Tag[];
  entities: Entity[];
}

const EMPTY_STORE: StoreFile = { labels: [], tags: [], entities: [] };

/**
 * File-backed JSON store. Deliberate choice for v1: the label dataset is small, read-mostly
 * seed data (see ADR 0002) — a database adds setup friction (a live Postgres instance) for no
 * real benefit at this scale. Swapping this for a real database later is a same-interface
 * change, not an architectural one, so it didn't need its own ADR — see this file's docstring
 * as the record of that reasoning.
 */
export class JsonFileLabelStore implements LabelStore {
  readonly #path: string;
  #cache: StoreFile | null = null;

  constructor(filePath: string) {
    this.#path = filePath;
  }

  async #load(): Promise<StoreFile> {
    if (this.#cache) return this.#cache;
    try {
      const raw = await readFile(this.#path, "utf8");
      this.#cache = JSON.parse(raw) as StoreFile;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        this.#cache = structuredClone(EMPTY_STORE);
      } else {
        throw cause;
      }
    }
    return this.#cache;
  }

  async #save(): Promise<void> {
    if (!this.#cache) return;
    await writeFile(this.#path, JSON.stringify(this.#cache, null, 2) + "\n", "utf8");
  }

  async getLabel(address: Address): Promise<Label | null> {
    const store = await this.#load();
    const key = addressKey(address);
    return store.labels.find((l) => addressKey(l.address) === key) ?? null;
  }

  async getTags(address: Address): Promise<Tag[]> {
    const store = await this.#load();
    const key = addressKey(address);
    return store.tags.filter((t) => addressKey(t.address) === key);
  }

  async getEntity(address: Address): Promise<Entity | null> {
    const store = await this.#load();
    const key = addressKey(address);
    return store.entities.find((e) => e.addresses.some((a) => addressKey(a) === key)) ?? null;
  }

  async addLabel(label: Label): Promise<void> {
    const store = await this.#load();
    const key = addressKey(label.address);
    store.labels = [...store.labels.filter((l) => addressKey(l.address) !== key), label];
    await this.#save();
  }

  async addTag(tag: Tag): Promise<void> {
    const store = await this.#load();
    store.tags.push(tag);
    await this.#save();
  }

  async addEntity(entity: Entity): Promise<void> {
    const store = await this.#load();
    store.entities = [...store.entities.filter((e) => e.id !== entity.id), entity];
    await this.#save();
  }
}

/**
 * Read-through over several label datasets (one JSON file per source under data/labels/), so each
 * ingestion script can own and regenerate its own file without touching the others. Order is
 * priority: getLabel/getEntity return the first store's match (the store holds at most one Label
 * per address); getTags returns every store's tags, so an address listed by two sources keeps both
 * citations. Writes go to the first store.
 */
export class CompositeLabelStore implements LabelStore {
  readonly #stores: LabelStore[];

  constructor(stores: LabelStore[]) {
    if (stores.length === 0) throw new Error("CompositeLabelStore needs at least one store");
    this.#stores = stores;
  }

  get #primary(): LabelStore {
    return this.#stores[0] as LabelStore;
  }

  async getLabel(address: Address): Promise<Label | null> {
    for (const store of this.#stores) {
      const label = await store.getLabel(address);
      if (label) return label;
    }
    return null;
  }

  async getTags(address: Address): Promise<Tag[]> {
    const all = await Promise.all(this.#stores.map((s) => s.getTags(address)));
    return all.flat();
  }

  async getEntity(address: Address): Promise<Entity | null> {
    for (const store of this.#stores) {
      const entity = await store.getEntity(address);
      if (entity) return entity;
    }
    return null;
  }

  addLabel(label: Label): Promise<void> {
    return this.#primary.addLabel(label);
  }

  addTag(tag: Tag): Promise<void> {
    return this.#primary.addTag(tag);
  }

  addEntity(entity: Entity): Promise<void> {
    return this.#primary.addEntity(entity);
  }
}
