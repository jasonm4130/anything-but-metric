# Contributing

Help make a measurement easier to picture. Small, focused changes are welcome: a well-sourced reference, a parsing fix, a clearer result or an accessible interface improvement.

## Before opening a pull request

1. Reproduce the problem on the current tree.
2. Keep the change focused and describe the resulting behavior.
3. Run `npm test`, `npm run check`, `npm run eval:corpus` and `npm run build`.
4. Include a representative input and output when changing comparisons.

No Cloudflare account or model credentials are required for those checks. Do not add credentials, personal 1Password references, user measurements or raw provider logs to a pull request. Model evaluation that spends money is outside the default contribution workflow.

## Add a reference

The production facts live in `src/data/`. Start with a nearby row of the same dimension and follow its fields. Keep the ID stable and choose a family that groups related subjects for repeat avoidance.

Use an authoritative source you can inspect. Record the exact scope: model, configuration, date, species, load condition, pressure or other qualification that determines the value. Keep a short source note and the URL with the fact. Show the calculation when the value is derived.

Do not invent an average from a range, turn a maximum into a typical value, or choose an object's size to make one input produce a tidy answer. Defined fictional props are allowed when their construction is explicit. A fixed layout for printing bytes is a prop; an unsupported average book size is not a measured fact.

Only opt a fact into physical compositions when its role is supported. An appliance's electrical input can support an energy-duration comparison; an unspecified power rating cannot automatically do so. Keep existing scale and physics bounds. Add a meaningful test when changing a formula or addressing a boundary failure.

Run the corpus sweep after adding references. Review the resulting text as well as the passing assertions: a correct calculation can still be hard to picture. A new reference should improve coverage, variety or clarity.

## Bugs and ideas

For an ordinary bug, include the input, what happened, what you expected and the browser or local command. Remove personal information before posting. For a security issue, use the private reporting route in [SECURITY.md](SECURITY.md).

This is a side project. A focused issue or pull request is easier to review than a large redesign, and response times may vary.
