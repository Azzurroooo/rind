import { automationPages } from "./automation.js";
import { configPages } from "./config.js";
import { loginPages } from "./login.js";
import { modelPages } from "./model.js";
import { sessionsPages } from "./sessions.js";
import { startPages } from "./start.js";
import { teamPages } from "./team.js";

export const TOUR_TOPICS = [
  { id: "start", title: "Start", pages: startPages },
  { id: "team", title: "Team", pages: teamPages },
  { id: "sessions", title: "Sessions", pages: sessionsPages },
  { id: "model", title: "Model", pages: modelPages },
  { id: "automation", title: "Automation", pages: automationPages },
  { id: "login", title: "Login", pages: loginPages },
  { id: "config", title: "Config", pages: configPages },
];

export function tourPages() {
  return TOUR_TOPICS.flatMap((topic) => topic.pages);
}

export function findTourPage(id) {
  return tourPages().find((page) => page.id === id) || null;
}
