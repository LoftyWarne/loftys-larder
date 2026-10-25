# Lofty's Larder

A meal planner for one household of cooks: recipes, a weekly plan built from them, and the shopping list the plan produces.

## Language

### Getting recipes in

**Recipe Import**:
Turning a recipe that already exists outside the app into a Larder recipe, with a model doing the transcription and a cook approving the result.
_Avoid_: scrape, parse, OCR, AI recipe

**Import input**:
What the cook hands to a Recipe Import: one or more images, a Document, a web link, or pasted text.
_Avoid_: source, upload, capture

**Document**:
A PDF, plain-text, Markdown or HTML file holding a recipe, handed to a Recipe Import whole. A photo or screenshot is an image, never a Document.
_Avoid_: file, attachment

**Import Review**:
The step where a cook checks and corrects what a Recipe Import proposed, alongside its import input, before the recipe exists.
_Avoid_: preview, confirmation

**Estimate**:
A value in a Recipe Import's proposal that the import input didn't state, so the model supplied it, such as nutrition, a time, or a converted quantity.
_Avoid_: guess, suggestion

**Source**:
Where a recipe came from: a named publication or site (e.g. "Mob Kitchen"), optionally with a link or a detail such as a page number.
_Avoid_: origin, input

**Recipe Generation**:
Asking a model to invent a recipe that doesn't exist yet from a description of what the cook wants. Distinct from Recipe Import: there is no original to check the result against.
_Avoid_: AI import, idea import

### Cooking

**Cook mode**:
A view of one recipe for use while cooking. It starts with a gather screen of the ingredients, then shows one method step per screen in large type and keeps the screen on.
_Avoid_: kitchen mode, step mode, recipe player

### Planning

**Plan Proposal**:
A model's proposed meals for a new plan's slots, made from the cook's dates, who's eating, Fixed meals and Brief, and drawn only from the household's own recipes. Nothing in it exists until the cook applies it.
_Avoid_: AI plan, generated plan, auto-plan, meal suggestions

**Plan Review**:
The step where a cook keeps, swaps or discards each slot of a Plan Proposal, or asks for another go, before the plan exists.
_Avoid_: preview, approval

**Brief**:
Optional plain text a cook writes to steer a Plan Proposal, such as the mood of the week, how much effort to spend, or ingredients to use up.
_Avoid_: prompt, instructions, notes

**Fixed meal**:
A slot the cook settles before a Plan Proposal is made: a specific recipe, eat out, takeaway, or a batch to cook for later. The model plans around it and never changes it.
_Avoid_: pinned slot, locked slot

### Judging recipes

**Health Score**:
A model's judgement, from 1 to 10, of how healthy one serving of a recipe is as eaten, measured against all food rather than against the dish's role (a light dessert still scores as a dessert). A judgement, not an Estimate: it isn't a value the recipe failed to state.
_Avoid_: health rating, nutrition score, grade, Nutri-Score

**Suggestion**:
One change, offered with a Health Score, that would make the recipe healthier while keeping it the same dish. The cook decides whether to make it.
_Avoid_: tip (a method step's tip), advice, swap

**Out of date**:
A Health Score whose recipe has changed, in what the score was based on, since it was scored. It's kept and shown as out of date, not removed.
_Avoid_: stale, expired, invalid
