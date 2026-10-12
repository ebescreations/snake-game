# Snake

A small browser Snake game. Four speed levels, and you can steer with the keyboard, the mouse, or by swiping. No build step, no dependencies, no tracking.

**[Play it here](https://ebescreations.github.io/snake-game/)**

## Controls

| Input | What it does |
| --- | --- |
| Arrow keys / `W` `A` `S` `D` | Steer |
| Mouse | In Mouse mode the snake heads for the cell under the pointer |
| Swipe | Steer, on touchscreens |
| Click / tap / `Space` | Start, pause, resume |
| `R` / New game | Start a fresh run |

No U-turns: from any heading you can only turn left or right. Hitting a wall or your own tail ends the run. Fill the board to win.

## Levels

| Level | Speed | Points per food |
| --- | --- | --- |
| Easy | Slow, constant | 5 |
| Medium | Quick, constant | 15 |
| Advanced | Very quick, constant | 25 |
| Classic | Starts gently, accelerates to Advanced pace | 8 → 23 |

Faster play pays more per food, so scores are not comparable between levels. Each level keeps its own best score in `localStorage`.

## Running it locally

It is three static files, so opening `index.html` in a browser works. If you would rather serve it:

```bash
python -m http.server 8000
# then visit http://localhost:8000
```

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. Settings → Pages → Source: *Deploy from a branch*.
3. Pick your default branch and the `/ (root)` folder, then save.

The paths are all relative, so it works from a project subpath without changes.

## How it works

| File | Contents |
| --- | --- |
| `index.html` | Markup, the controls, and the in-page guide |
| `styles.css` | All styling; colours live in custom properties at the top |
| `game.js` | The whole game in one IIFE: state, input, simulation, canvas rendering |
| `favicon.svg` | Tab icon |

The game is a 20×20 grid rendered to a canvas. A `requestAnimationFrame` loop accumulates elapsed time and steps the simulation once per `interval` milliseconds, so the speed is independent of the display refresh rate. The snake is an array of cells plus a `Set` of occupied keys for O(1) collision checks.

## Browser support

Any current version of Chrome, Edge, Firefox, or Safari. It uses `Pointer Events`, `Set`, and canvas `roundRect`, with a path fallback for the last one.

## Licence

MIT. See [LICENSE](LICENSE).
