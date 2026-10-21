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
