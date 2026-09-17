import { automationPages } from "./automation.js";
import { configPages } from "./config.js";
import { loginPages } from "./login.js";
import { modelPages } from "./model.js";
import { sessionsPages } from "./sessions.js";
import { startPages } from "./start.js";
import { teamPages } from "./team.js";

export const TOUR_TOPICS = [
  { id: "start", title: "Start", pages: startPages },
  { id: "login", title: "Connect a provider", pages: loginPages },
  { id: "model", title: "Model", pages: modelPages },
  { id: "sessions", title: "Sessions", pages: sessionsPages },
  { id: "config", title: "Config", pages: configPages },
  { id: "team", title: "Team", pages: teamPages },
  { id: "automation", title: "Automation", pages: automationPages },
];

export function tourPages() {
  return TOUR_TOPICS.flatMap((topic) => topic.pages);
}

export function findTourPage(id) {
  return tourPages().find((page) => page.id === id) || null;
}
