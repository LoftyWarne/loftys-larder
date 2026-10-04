# Lofty's Larder

A meal planner for one household of cooks: recipes, a weekly plan built from them, and the shopping list the plan produces.

## Language

### Getting recipes in

**Recipe Import**:
Turning a recipe that already exists outside the app into a Larder recipe, with a model doing the transcription and a cook approving the result.
_Avoid_: scrape, parse, OCR, AI recipe

**Import input**:
What the cook hands to a Recipe Import: one or more images, a web link, or pasted text.
_Avoid_: source, upload, capture

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
