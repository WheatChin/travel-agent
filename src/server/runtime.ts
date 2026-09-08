import path from "node:path";
import { openRepository, type TripRepository } from "@/server/repository";
import { createLibraryHandlers, type RuntimeMode } from "@/server/http/library";
import { errorResponse } from "@/server/http/security";

const runtimeGlobal = globalThis as typeof globalThis & {
  travelLibraryRepositories?: Map<string, TripRepository>;
};

function databasePath() {
  return path.resolve(process.cwd(), process.env.DATABASE_PATH ?? "data/travel-agent.sqlite");
}

export function getRepository(): TripRepository {
  const resolvedPath = databasePath();
  const repositories = runtimeGlobal.travelLibraryRepositories ??= new Map();
  let repository = repositories.get(resolvedPath);
  if (!repository) {
    repository = openRepository({ path: resolvedPath });
    repositories.set(resolvedPath, repository);
  }
  return repository;
}

export function closeRuntime(): void {
  const repositories = runtimeGlobal.travelLibraryRepositories;
  if (!repositories) return;
  for (const [key, repository] of repositories) {
    repository.close();
    repositories.delete(key);
  }
}

function runtimeMode(): RuntimeMode {
  const mode = process.env.TRAVEL_RUNTIME_MODE ?? "live";
  if (mode !== "live" && mode !== "fake" && mode !== "fixture") {
    throw new Error("Invalid runtime mode.");
  }
  return mode;
}

// Configuration and SQLite acquisition happen inside the request error boundary.
export async function withLibrary(
  action: (handlers: ReturnType<typeof createLibraryHandlers>) => Promise<Response>,
): Promise<Response> {
  try {
    return await action(createLibraryHandlers({
      repository: getRepository,
      appOrigin: process.env.APP_ORIGIN ?? "http://127.0.0.1:3000",
      mode: runtimeMode(),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
