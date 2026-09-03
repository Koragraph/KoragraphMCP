// File type classification rules per repository stack
// Order matters — first match wins

const BACKEND_RULES = [
  // ── Filename-suffix rules (package-layout agnostic) ──────────────────────────
  // Match by class-name suffix so feature-packaged repos (e.g. owner/OwnerController.java,
  // not controller/OwnerController.java) are classified correctly. These run before the
  // directory rules so Spring conventions win regardless of how packages are organised.
  { pattern: /[^/]*Controller\.java$/,          type: 'CONTROLLER' },
  { pattern: /[^/]*(?:Repository|Dao)\.java$/,  type: 'REPOSITORY' },
  { pattern: /[^/]*(?:ServiceImpl|Service)\.java$/, type: 'SERVICE' },
  { pattern: /[^/]*Scheduler\.java$/,           type: 'SCHEDULER' },
  { pattern: /[^/]*Config(?:uration)?\.java$/,  type: 'CONFIG' },
  { pattern: /[^/]*Constants?\.java$/,          type: 'CONSTANTS' },
  { pattern: /[^/]*(?:Entity|Dto|DTO|VO|Request|Response|Event)\.java$/, type: 'ENTITY' },
  { pattern: /[^/]*Application\.java$/,          type: 'SERVICE' },
  // Common utility/helper suffixes — any Java class carrying business logic that doesn't
  // follow controller/service/repo conventions still deserves extraction.
  { pattern: /[^/]*(?:Validator|Helper|Util|Utils|Handler|Listener|Interceptor|Adapter|Converter|Factory|Manager|Filter|Formatter|Aspect|Builder|Mapper|Provider|Resolver|Processor)\.java$/, type: 'SERVICE' },
  { pattern: /[^/]*(?:Exception|Error)\.java$/, type: 'ENTITY' },

  // ── Directory-layout rules (for files without a conventional suffix) ─────────
  { pattern: /src\/main\/java\/.*\/cache\/[^/]+\.java$/, type: 'SERVICE' },
  { pattern: /src\/main\/java\/.*\/controller\/[^/]+\.java$/, type: 'CONTROLLER' },
  { pattern: /src\/main\/java\/.*\/service\/[^/]+\.java$/, type: 'SERVICE' },
  { pattern: /src\/main\/java\/.*\/repository\/[^/]+\.java$/, type: 'REPOSITORY' },
  { pattern: /src\/main\/java\/.*\/entity\/[^/]+\.java$/, type: 'ENTITY' },
  { pattern: /src\/main\/java\/.*\/entities\/[^/]+\.java$/, type: 'ENTITY' },
  { pattern: /src\/main\/java\/.*\/domain\/[^/]+\.java$/, type: 'ENTITY' },
  { pattern: /src\/main\/java\/.*\/model\/[^/]+\.java$/, type: 'ENTITY' },
  { pattern: /src\/main\/java\/.*\/scheduler\/[^/]+\.java$/, type: 'SCHEDULER' },
  { pattern: /src\/main\/java\/.*\/config\/[^/]+\.java$/, type: 'CONFIG' },
  { pattern: /src\/main\/java\/.*\/constants\/[^/]+\.java$/, type: 'CONSTANTS' },
  { pattern: /src\/main\/java\/.*\/methods\/[^/]+\.java$/, type: 'SERVICE' },
  { pattern: /src\/main\/java\/.*\/kpi\/[^/]+\.java$/, type: 'SERVICE' },
  { pattern: /src\/main\/java\/.*\/utils?\/[^/]+\.java$/, type: 'SERVICE' },
  { pattern: /src\/main\/java\/.*\/validators?\/[^/]+\.java$/, type: 'SERVICE' },
  { pattern: /src\/main\/java\/.*\/helpers?\/[^/]+\.java$/, type: 'SERVICE' },
  { pattern: /src\/main\/java\/.*\/handlers?\/[^/]+\.java$/, type: 'SERVICE' },
  { pattern: /src\/main\/java\/.*\/listeners?\/[^/]+\.java$/, type: 'SERVICE' },
  { pattern: /src\/main\/java\/.*\/adapters?\/[^/]+\.java$/, type: 'SERVICE' },
  { pattern: /src\/main\/java\/.*\/converters?\/[^/]+\.java$/, type: 'SERVICE' },
  { pattern: /src\/main\/java\/.*\/mappers?\/[^/]+\.java$/, type: 'SERVICE' },
  { pattern: /src\/main\/java\/.*\/factories\/[^/]+\.java$/, type: 'SERVICE' },
  { pattern: /src\/main\/java\/.*\/events?\/[^/]+\.java$/, type: 'ENTITY' },
  { pattern: /src\/main\/java\/.*\/exceptions?\/[^/]+\.java$/, type: 'ENTITY' },
  { pattern: /src\/main\/java\/.*[A-Z][^/]*Application\.java$/, type: 'SERVICE' },
  { pattern: /db\/[^/]+\.sql$/, type: 'SCHEMA' },
  { pattern: /^pom\.xml$/, type: 'POM' },
  { pattern: /src\/main\/resources\/application.*\.properties$/, type: 'CONFIG' },
  { pattern: /src\/main\/resources\/application.*\.yml$/, type: 'CONFIG' },
  // Log configuration — captures actual log file paths for troubleshooting
  // Spring Boot uses Logback by default; also match log4j2 variants for non-default setups.
  { pattern: /src\/main\/resources\/logback(?:-spring|-test)?\.xml$/, type: 'CONFIG' },
  { pattern: /src\/main\/resources\/log4j2?(?:-spring)?\.(?:xml|properties)$/, type: 'CONFIG' },
  { pattern: /^README\.md$/i, type: 'README' },
  { pattern: /Dockerfile$|\.gitignore$|\.gitlab-ci\.yml$|\.sh$/, type: 'OTHER' },
];

// Two layout conventions exist in Python web code and both must be covered.
//
// The DIRECTORY convention (`models/user.py`, `routers/auth.py`) is FastAPI-shaped and was the only
// one matched here. The MODULE convention (`app/models.py`, `app/views.py`) is Django's, and Django
// is the most widely deployed Python web framework — so every Django `models.py` in existence fell
// through to OTHER and was skipped by the extractor.
//
// Measured on django-machina: 324 of 535 files skipped, and the skipped set
// included `machina/apps/forum/models.py` and `forum_polls/models.py`. Those modules hold
// `Topic = model_factory(AbstractTopic)` — the only textual link between a concrete model and the
// abstract base its fields are declared on. Losing them removes exactly the structure a code graph
// exists to supply, since no lexical search can bridge that gap either.
//
// The content fallback did not save them: it looks for `class X(models.Model)`, and a model built
// by a factory call has no class declaration to match.
const PYTHON_RULES = [
  { pattern: /(?:routers|routes)\/[^/]+\.py$/, type: 'PYTHON_CONTROLLER' },
  { pattern: /(?:services|service)\/[^/]+\.py$|(?:^|\/)service\.py$/, type: 'PYTHON_SERVICE' },
  { pattern: /(?:models|schemas)\/[^/]+\.py$/, type: 'PYTHON_MODEL' },
  { pattern: /(?:repositories|crud)\/[^/]+\.py$/, type: 'PYTHON_REPOSITORY' },

  // Django / DRF module convention. `[a-z_]*` so `abstract_models.py` and `base_models.py` —
  // where the fields actually live in an abstract-model codebase — are covered too.
  { pattern: /(?:^|\/)[a-z_]*models\.py$|(?:^|\/)serializers\.py$|(?:^|\/)managers\.py$/, type: 'PYTHON_MODEL' },
  { pattern: /(?:^|\/)views\.py$|(?:^|\/)urls\.py$|(?:^|\/)viewsets\.py$/, type: 'PYTHON_CONTROLLER' },
  { pattern: /(?:^|\/)forms\.py$|(?:^|\/)admin\.py$|(?:^|\/)signals\.py$|(?:^|\/)validators\.py$/, type: 'PYTHON_SERVICE' },

  { pattern: /(?:^|\/)config[^/]*\.py$|(?:^|\/)settings[^/]*\.py$/, type: 'PYTHON_CONFIG' },
  { pattern: /^requirements\.txt$|^pyproject\.toml$/, type: 'POM' },
  { pattern: /^README\.md$/i, type: 'README' },
];

// Angular rules — TypeScript Angular projects
const ANGULAR_RULES = [
  { pattern: /src\/.*endpoints?\.service\.ts$|src\/.*\.urls\.ts$|src\/.*api-routes\.ts$/, type: 'ANGULAR_URL_REGISTRY' },
  { pattern: /src\/.*\.service\.ts$/, type: 'ANGULAR_SERVICE' },
  { pattern: /src\/.*\.component\.ts$/, type: 'ANGULAR_COMPONENT' },
  { pattern: /src\/.*\.model\.ts$|src\/.*\/models\/.*\.ts$|src\/.*\.interface\.ts$/, type: 'ANGULAR_MODEL' },
  { pattern: /src\/.*\.guard\.ts$|src\/.*\.interceptor\.ts$/, type: 'ANGULAR_SERVICE' },
  { pattern: /src\/app\/app-routing\.module\.ts$|src\/.*\/routing\.module\.ts$|src\/.*\.routes\.ts$/, type: 'ANGULAR_ROUTES' },
  { pattern: /^src\/environments\/environment.*\.ts$/, type: 'CONFIG' },
  { pattern: /^package\.json$/, type: 'POM' },
  { pattern: /^README\.md$/i, type: 'README' },
];

// React JS (CRA / Vite / plain JS+TS) rules.
// Uses REACT_* file types (and matching node_type in prompts) so UI/API show React, not Angular.
// Order: specific API/Redux/hooks directories first, generic components last.
// Extensions: .js .jsx .ts .tsx — TypeScript React is common; .ts covers RTK slices / API modules.
const REACT_RULES = [
  // CRA / Vite / RN entry — must beat NODE_RULES' src/index.js → NODE_ENTRYPOINT when stack is REACT
  { pattern: /^src\/index\.(jsx?|tsx?)$|^src\/main\.(tsx|ts|jsx|js)$/, type: 'REACT_COMPONENT' },
  // API / HTTP service modules (include .js — e.g. shared/endpoints.js)
  { pattern: /src\/(?:.*\/)?(?:services?|api|apis?)\/.*\.(jsx?|tsx|ts|js)$/, type: 'REACT_SERVICE' },
  // Redux slices, reducers, store
  { pattern: /src\/(?:.*\/)?(?:redux|store|slices?|reducers?|actions?)\/.*\.(jsx?|tsx|ts|js)$/, type: 'REACT_SERVICE' },
  // Custom hooks
  { pattern: /src\/(?:.*\/)?hooks?\/.*\.(jsx?|tsx|ts|js)$/, type: 'REACT_SERVICE' },
  // Typical SPA folders (Next-style pages/, feature folders, layouts)
  { pattern: /src\/(?:.*\/)?(?:pages?|views?|screens?|features?|layouts?)\/.*\.(jsx?|tsx|ts|js)$/, type: 'REACT_COMPONENT' },
  // React components under src/components/ (CRA often uses .js)
  { pattern: /src\/(?:.*\/)?components?\/.*\.(jsx?|tsx|ts|js)$/, type: 'REACT_COMPONENT' },
  // Styles co-located with components — not extractable, explicit type vs OTHER
  { pattern: /src\/(?:.*\/)?components?\/.*\.css$/, type: 'REACT_STYLESHEET' },
  // Global styles at src root (e.g. index.css, App.css next to index)
  { pattern: /^src\/[^/]+\.css$/, type: 'REACT_STYLESHEET' },
  // Utilities, shared modules, small libs (createSocketURL, apiCache, endpoints.js, …)
  { pattern: /src\/utils\/.*\.(jsx?|tsx|ts|js)$/, type: 'REACT_SERVICE' },
  { pattern: /src\/shared\/.*\.(jsx?|tsx|ts|js)$/, type: 'REACT_SERVICE' },
  { pattern: /src\/lib\/.*\.(jsx?|tsx|ts|js)$/, type: 'REACT_SERVICE' },
  { pattern: /src\/(?:constants|config|context|providers?)\/.*\.(jsx?|tsx|ts|js)$/, type: 'REACT_SERVICE' },
  // Root App shell (CRA/Vite) — component, not the routes registry
  { pattern: /^src\/App\.(jsx?|tsx?|mjs|cjs)$/, type: 'REACT_COMPONENT' },
  // Client routing modules only (not App.js)
  { pattern: /src\/(?:.*\/)?(?:routes?|router)\/.*\.(jsx?|tsx|ts|js)$/, type: 'REACT_ROUTES' },
  // Avoid treating nested package.json as a UI manifest
  { pattern: /^src\/package\.json$/i, type: 'OTHER' },
  // JSON under src (manifests, locale files, feature flags) — extractable as REACT_MANIFEST
  { pattern: /^src\/.*\.json$/i, type: 'REACT_MANIFEST' },
  // Common CRA/bootstrap modules at src root (not UI components)
  { pattern: /^src\/i18n\.(jsx?|tsx?|ts|js|mjs|cjs)$/i, type: 'REACT_SERVICE' },
  { pattern: /^src\/reportWebVitals\.(jsx?|tsx?|ts|js)$/i, type: 'REACT_SERVICE' },
  // Direct children of src/ (mainComponent.js, newMainComponent.js, …)
  { pattern: /^src\/[^/]+\.(jsx?|tsx?|js|mjs|cjs)$/, type: 'REACT_COMPONENT' },
  { pattern: /^package\.json$/, type: 'POM' },
  { pattern: /^README\.md$/i, type: 'README' },
];

// Node.js rules — (?:.*\/)? makes the intermediate subdirectory optional so both
// flat layouts (src/controllers/file.js) and nested layouts (src/api/controllers/file.js) match.
// The trailing \/.*\.[jt]s$ (instead of \/[^/]+\.[jt]s$) allows files nested inside subdirectories
// of the typed folder (e.g. src/services/commonservice/authService.js).
// (?:src\/)? makes the src/ prefix optional to support repos with flat layouts (no src/ root).
const NODE_RULES = [
  // Entry-point files: main/server/app/index at root or inside src/, .js or .ts.
  { pattern: /^(?:main|server|app|index)\.[jt]sx?$/, type: 'NODE_ENTRYPOINT' },
  { pattern: /^src\/(?:main|server|app|index)\.[jt]sx?$/, type: 'NODE_ENTRYPOINT' },
  { pattern: /(?:src\/)?(?:.*\/)?(?:routes?|controllers?|router)\/.*\.[jt]s$/, type: 'NODE_CONTROLLER' },
  { pattern: /(?:src\/)?(?:.*\/)?(?:services?|methods|providers?|connectors?|extractors?|cronjobs?|cache|config|queries?)\/.*\.[jt]s$/, type: 'NODE_SERVICE' },
  { pattern: /(?:src\/)?(?:.*\/)?(?:models?|schemas?)\/.*\.[jt]s$/, type: 'NODE_MODEL' },
  { pattern: /(?:src\/)?(?:.*\/)?middlewares?\/.*\.[jt]s$/, type: 'NODE_SERVICE' },
  // Monorepo packages: packages/*/src/*.ts files not matching named-directory rules above
  { pattern: /packages\/[^/]+\/src\/[^/]+\.[jt]sx?$/, type: 'NODE_SERVICE' },
  { pattern: /^package\.json$/, type: 'POM' },
  { pattern: /^README\.md$/i, type: 'README' },
];

// .NET / ASP.NET Core rules — multi-project solution layout (project folders at repo root).
// Order matters: more specific paths first.
// Paths look like: {ProjectName}/Controllers/Foo.cs, {ProjectName}Service/Service/Bar.cs, etc.
const DOTNET_RULES = [
  // ── Controllers ([Route], [HttpGet/Post/Put/Patch/Delete]) ─────────────────
  { pattern: /Controllers\/[^/]+\.cs$/, type: 'DOTNET_CONTROLLER' },

  // ── Entry points (Program.cs + Startup.cs — any project depth) ────────────
  // Must be before DOTNET_PROCESSOR so processor/worker Program.cs is caught here.
  { pattern: /(?:^|\/)[Pp]rogram\.cs$/, type: 'DOTNET_ENTRYPOINT' },
  { pattern: /(?:^|\/)[Ss]tartup\.cs$/, type: 'DOTNET_ENTRYPOINT' },

  // ── Repository / Data access ───────────────────────────────────────────────
  // Handles the common misspelling "Respository" as well as correct spelling.
  { pattern: /Res?pository\/[^/]+\.cs$/, type: 'DOTNET_REPOSITORY' },
  { pattern: /(?:Dal|DataAccess)\/[^/]+\.cs$/, type: 'DOTNET_REPOSITORY' },
  // Projects with a ".Data" suffix, the conventional ASP.NET data-access project name.
  { pattern: /[^/]*\.Data[^/]*\/[^/]+\.cs$/, type: 'DOTNET_REPOSITORY' },
  // File-level data access — flat-structure repos (e.g. OraDataAccess.cs, SqlDataAccess.cs)
  { pattern: /[^/]*DataAccess[^/]*\.cs$/, type: 'DOTNET_REPOSITORY' },
  // ── Services (Service/ subfolder or *Service.cs anywhere) ─────────────────
  // Middlewares/ mapped here (request-pipeline components — same extraction value as service).
  { pattern: /Middlewares?\/[^/]+\.cs$/, type: 'DOTNET_SERVICE' },
  { pattern: /Filters?\/[^/]+\.cs$/, type: 'DOTNET_SERVICE' },
  { pattern: /Service\/[^/]+\.cs$/, type: 'DOTNET_SERVICE' },
  { pattern: /[^/]+Service\.cs$/, type: 'DOTNET_SERVICE' },

  // ── Background processors / queue consumers ────────────────────────────────
  // Matches project folders whose name contains Processor, Worker, Consumer, or QueueReader.
  // Program.cs in these projects is already caught above.
  { pattern: /[^/]*(?:Processor|Worker|Consumer|QueueReader)[^/]*\/[^/]+\.cs$/, type: 'DOTNET_PROCESSOR' },

  // ── Models / DTOs / Entities ───────────────────────────────────────────────
  // Matches project folders whose name contains Models.
  { pattern: /[^/]*Models?[^/]*\/[^/]+\.cs$/, type: 'DOTNET_MODEL' },
  { pattern: /(?:Models?|DTOs?|Entities|Requests?|Responses?)\/[^/]+\.cs$/, type: 'DOTNET_MODEL' },

  // ── Config ─────────────────────────────────────────────────────────────────
  { pattern: /appsettings(?:\.[^/.]+)?\.json$/, type: 'CONFIG' },

  // ── Project/solution files ─────────────────────────────────────────────────
  { pattern: /[^/]+\.csproj$/, type: 'POM' },
  { pattern: /[^/]+\.sln$/, type: 'OTHER' },

  // ── Skip — no extraction value ─────────────────────────────────────────────
  { pattern: /\.(?:Designer|generated|g|AssemblyInfo)\.cs$/i, type: 'OTHER' },
  // Log configuration — captures appender file paths for ops troubleshooting.
  { pattern: /(?:nlog|log4net)(?:\.[^/]*)?\.(config|xml)$/, type: 'CONFIG' },

  // ── Catch-all for flat-structure .cs files ─────────────────────────────────
  // Flat-structure repos (no Controllers/, Service/, Repository/ subfolders) —
  // any .cs file not already matched gets classified as DOTNET_SERVICE.
  // Skip rules above (.Designer.cs, AssemblyInfo.cs) take priority since they appear first.
  { pattern: /[^/]+\.cs$/, type: 'DOTNET_SERVICE' },

  { pattern: /^README\.md$/i, type: 'README' },
];

// Go (Gin / Echo / Fiber / net/http) rules
const GO_RULES = [
  { pattern: /(?:^|\/)go\.mod$/, type: 'POM' },
  { pattern: /(?:handlers?|controllers?|routes?|api)\/[^/]+\.go$/, type: 'GO_HANDLER' },
  { pattern: /(?:services?|usecases?|pkg\/[^/]+)\/[^/]+\.go$/, type: 'GO_SERVICE' },
  { pattern: /(?:models?|entities?|domain)\/[^/]+\.go$/, type: 'GO_MODEL' },
  { pattern: /(?:repositor(?:y|ies)|store|dao)\/[^/]+\.go$/, type: 'GO_REPOSITORY' },
  { pattern: /(?:^|\/)main\.go$/, type: 'GO_ENTRYPOINT' },
  { pattern: /^README\.md$/i, type: 'README' },
  { pattern: /[^/]+\.go$/, type: 'GO_SERVICE' },
];

// Ruby on Rails / Sinatra rules
const RUBY_RULES = [
  { pattern: /(?:^|\/)Gemfile$/, type: 'POM' },
  { pattern: /app\/controllers\/[^/]+\.rb$/, type: 'RUBY_CONTROLLER' },
  { pattern: /app\/models\/[^/]+\.rb$/, type: 'RUBY_MODEL' },
  { pattern: /app\/services\/[^/]+\.rb$/, type: 'RUBY_SERVICE' },
  { pattern: /app\/serializers?\/[^/]+\.rb$/, type: 'RUBY_MODEL' },
  { pattern: /app\/jobs\/[^/]+\.rb$/, type: 'RUBY_SERVICE' },
  { pattern: /(?:config\/routes\.rb|config\/application\.rb)$/, type: 'CONFIG' },
  { pattern: /db\/schema\.rb$/, type: 'SCHEMA' },
  { pattern: /^README\.md$/i, type: 'README' },
  { pattern: /[^/]+\.rb$/, type: 'RUBY_SERVICE' },
];

// PHP / Laravel / Symfony rules
const PHP_RULES = [
  { pattern: /(?:^|\/)composer\.json$/, type: 'POM' },
  { pattern: /app\/Http\/Controllers\/[^/]+\.php$/, type: 'PHP_CONTROLLER' },
  { pattern: /(?:App|app)\/(?:Models?|Entities?)\/[^/]+\.php$/, type: 'PHP_MODEL' },
  { pattern: /(?:App|app)\/(?:Services?|Repositories?)\/[^/]+\.php$/, type: 'PHP_SERVICE' },
  { pattern: /src\/(?:Controller|Controllers?)\/[^/]+\.php$/, type: 'PHP_CONTROLLER' },
  { pattern: /src\/(?:Service|Services?)\/[^/]+\.php$/, type: 'PHP_SERVICE' },
  { pattern: /src\/(?:Entity|Entities?)\/[^/]+\.php$/, type: 'PHP_MODEL' },
  { pattern: /src\/(?:Repository|Repositories?)\/[^/]+\.php$/, type: 'PHP_SERVICE' },
  { pattern: /config\/[^/]+\.php$/, type: 'CONFIG' },
  // Frontend JS source files bundled with the PHP app (e.g. Symfony assets/controllers/*.js, assets/js/*.js)
  { pattern: /assets\/(?:[^/]+\/)?[^/]+\.js$/, type: 'NODE_SERVICE' },
  { pattern: /^README\.md$/i, type: 'README' },
  { pattern: /[^/]+\.php$/, type: 'PHP_SERVICE' },
];

// Vue.js / Nuxt.js rules
const VUE_RULES = [
  { pattern: /^package\.json$/, type: 'POM' },
  { pattern: /(?:^|\/)(?:vue|nuxt)\.config\.[jt]s$/, type: 'CONFIG' },
  { pattern: /[^/]+\.vue$/, type: 'VUE_COMPONENT' },
  { pattern: /(?:src\/)?(?:.*\/)?(?:stores?|composables?|use\w+)\/.*\.[jt]s$/, type: 'VUE_SERVICE' },
  { pattern: /(?:src\/)?(?:.*\/)?(?:api|services?|plugins?)\/.*\.[jt]s$/, type: 'VUE_SERVICE' },
  { pattern: /(?:src\/)?(?:.*\/)?(?:router|routes?)\/.*\.[jt]s$/, type: 'REACT_ROUTES' },
  { pattern: /(?:src\/)?(?:.*\/)?(?:pages?|views?|layouts?)\/.*\.[jt]s$/, type: 'VUE_COMPONENT' },
  { pattern: /(?:src\/)?(?:.*\/)?components?\/.*\.(?:js|ts)$/, type: 'VUE_COMPONENT' },
  // Entry-point JS/TS at src/ root (e.g. src/main.js bootstraps the Vue app)
  { pattern: /^src\/[^/]+\.[jt]sx?$/, type: 'VUE_SERVICE' },
  { pattern: /^README\.md$/i, type: 'README' },
];

// Kotlin backend rules (Ktor / Spring Boot Kotlin)
const KOTLIN_RULES = [
  { pattern: /(?:^|\/)build\.gradle(?:\.kts)?$/, type: 'POM' },
  { pattern: /(?:controller|resource|endpoint)\/[^/]+\.kt$/, type: 'CONTROLLER' },
  { pattern: /(?:service|usecase|application)\/[^/]+\.kt$/, type: 'KOTLIN_SERVICE' },
  { pattern: /(?:repository|repo|persistence)\/[^/]+\.kt$/, type: 'REPOSITORY' },
  { pattern: /(?:model|domain|entity|dto)\/[^/]+\.kt$/, type: 'KOTLIN_ENTITY' },
  { pattern: /(?:config|configuration)\/[^/]+\.kt$/, type: 'CONFIG' },
  { pattern: /[^/]+(?:DataClass|Dto|Request|Response)\.kt$/, type: 'KOTLIN_ENTITY' },
  { pattern: /[^/]+Sealed\.kt$|[^/]+Result\.kt$/, type: 'KOTLIN_ENTITY' },
  { pattern: /[^/]*Application\.kt$/, type: 'NODE_ENTRYPOINT' },
  { pattern: /^README\.md$/i, type: 'README' },
  { pattern: /[^/]+\.kt$/, type: 'KOTLIN_SERVICE' },
];

// Rust (Actix-web / Axum / Rocket) rules
const RUST_RULES = [
  { pattern: /(?:^|\/)Cargo\.toml$/, type: 'POM' },
  { pattern: /(?:handlers?|controllers?|routes?|api|http)\/.+\.rs$/, type: 'RUST_HANDLER' },
  { pattern: /(?:services?|domain|usecases?)\/[^/]+\.rs$/, type: 'RUST_SERVICE' },
  { pattern: /(?:models?|entities?|schema)\/[^/]+\.rs$/, type: 'RUST_MODEL' },
  { pattern: /(?:repositor(?:y|ies)|store|db)\/[^/]+\.rs$/, type: 'RUST_SERVICE' },
  { pattern: /(?:^|\/)main\.rs$/, type: 'RUST_SERVICE' },
  { pattern: /^README\.md$/i, type: 'README' },
  { pattern: /[^/]+\.rs$/, type: 'RUST_SERVICE' },
];

// C / C++ rules
//
// ast-extractor.js has mapped .c/.h/.cpp/.cc/.cxx/.hpp/.hh/.hxx to its `cpp` grammar since
// Phase 1, but nothing ever routed a C/C++ file to it: there was no CPP entry in
// STACK_RULES_MAP, so every C/C++ file fell through to the universal OTHER fallback and OTHER is
// not extractable. Measured on apache/thrift: 491 of 491 C/C++ files classified OTHER — 31% of
// the repository's source, silently absent from the graph with no error anywhere.
//
// Header files are included deliberately. In C++ a header is not an accessory to the .cpp: class
// definitions, inline functions and templates live there, and for a header-only library it is
// the entire library.
const CPP_RULES = [
  { pattern: /(?:^|\/)CMakeLists\.txt$/, type: 'POM' },
  { pattern: /(?:handlers?|controllers?|routes?|api|server)\/[^/]+\.(?:c|cc|cpp|cxx)$/, type: 'CPP_HANDLER' },
  { pattern: /(?:models?|entities?|domain|types?)\/[^/]+\.(?:c|cc|cpp|cxx|h|hpp|hh|hxx)$/, type: 'CPP_MODEL' },
  { pattern: /^README\.md$/i, type: 'README' },
  { pattern: /[^/]+\.(?:c|cc|cpp|cxx|h|hpp|hh|hxx)$/, type: 'CPP_SERVICE' },
];

// File types that go through the LLM pipeline
// NOTE: SCHEMA (.sql) and README are intentionally excluded — they are classified but not LLM-processed.
// SCHEMA is managed via the database_schemas flow; README creates duplicate/low-quality nodes.
const EXTRACTABLE_TYPES = new Set([
  // Java Spring
  'CONTROLLER', 'SERVICE', 'REPOSITORY', 'ENTITY', 'SCHEDULER', 'CONFIG', 'CONSTANTS',
  'POM',
  // Python
  'PYTHON_CONTROLLER', 'PYTHON_SERVICE', 'PYTHON_MODEL', 'PYTHON_REPOSITORY',
  // Angular
  'ANGULAR_SERVICE', 'ANGULAR_MODEL', 'ANGULAR_ROUTES', 'ANGULAR_COMPONENT', 'ANGULAR_URL_REGISTRY',
  // React (same pipeline as Angular SPA; distinct types for UI/API clarity)
  'REACT_SERVICE', 'REACT_ROUTES', 'REACT_MANIFEST', 'REACT_COMPONENT',
  // Node.js
  'NODE_ENTRYPOINT', 'NODE_CONTROLLER', 'NODE_SERVICE', 'NODE_MODEL',
  // .NET / ASP.NET Core
  'DOTNET_CONTROLLER', 'DOTNET_SERVICE', 'DOTNET_REPOSITORY', 'DOTNET_MODEL',
  'DOTNET_PROCESSOR', 'DOTNET_ENTRYPOINT',
  // Go
  'GO_HANDLER', 'GO_SERVICE', 'GO_MODEL', 'GO_REPOSITORY', 'GO_ENTRYPOINT',
  // Ruby
  'RUBY_CONTROLLER', 'RUBY_SERVICE', 'RUBY_MODEL',
  // PHP
  'PHP_CONTROLLER', 'PHP_SERVICE', 'PHP_MODEL',
  // Vue.js
  'VUE_COMPONENT', 'VUE_SERVICE',
  // Kotlin
  'KOTLIN_SERVICE', 'KOTLIN_ENTITY',
  // Rust
  'RUST_HANDLER', 'RUST_SERVICE', 'RUST_MODEL',
  // C / C++
  'CPP_HANDLER', 'CPP_SERVICE', 'CPP_MODEL',
  // Test files (all languages)
  'TEST',
]);

// Dispatch map: stack value → rule set. BACKEND is the alias JAVA_SPRING repos are also
// recorded under.
const STACK_RULES_MAP = {
  JAVA_SPRING: BACKEND_RULES,
  BACKEND:     BACKEND_RULES,
  PYTHON:      PYTHON_RULES,
  ANGULAR:     ANGULAR_RULES,
  REACT:       REACT_RULES,
  NODE:        NODE_RULES,
  DOTNET:      DOTNET_RULES,
  GO:          GO_RULES,
  RUBY:        RUBY_RULES,
  PHP:         PHP_RULES,
  VUE:         VUE_RULES,
  RUST:        RUST_RULES,
  KOTLIN:      KOTLIN_RULES,
  CPP:         CPP_RULES,
};

// Universal test-file patterns — evaluated before any stack rules so test files are never
// misclassified as controllers/services/models regardless of their path or name suffix.
// Order: most specific first (longer alternatives listed first per find -regex convention).
const TEST_FILE_PATTERNS = [
  { pattern: /[Tt]est[^/]*\.java$|[^/]+Test\.java$/, type: 'TEST' },           // Java JUnit
  { pattern: /\.(?:spec|test|stories|e2e)\.[jt]sx?$/, type: 'TEST' },           // JS/TS tests, stories, and browser scenarios
  { pattern: /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/, type: 'TEST' },         // Python pytest/unittest
  { pattern: /(?:^|\/)([^/]+)_spec\.rb$/, type: 'TEST' },                       // Ruby RSpec
  { pattern: /[^/]+_test\.go$/, type: 'TEST' },                                  // Go testing (co-located)
  { pattern: /[^/]+Tests?\.cs$|[^/]+Spec\.cs$/, type: 'TEST' },                 // C# xUnit/NUnit/MSTest
  { pattern: /[^/]+Test\.kt$|[^/]+Spec\.kt$/, type: 'TEST' },                   // Kotlin JUnit/Kotest
  { pattern: /[^/]+Test\.swift$|[^/]+Spec\.swift$/, type: 'TEST' },             // Swift XCTest
  { pattern: /[^/]+Test\.php$|[^/]+Test\.class\.php$/, type: 'TEST' },          // PHP PHPUnit
];

function classify(filePath, stack) {
  // Universal test file detection — runs before stack rules so test files are never
  // misclassified as production code types regardless of directory or stack.
  for (const rule of TEST_FILE_PATTERNS) {
    if (rule.pattern.test(filePath)) return rule.type;
  }

  const rules = STACK_RULES_MAP[stack] || BACKEND_RULES;

  for (const rule of rules) {
    if (rule.pattern.test(filePath)) return rule.type;
  }

  // Universal fallbacks regardless of stack
  if (/README\.md$/i.test(filePath)) return 'README';
  if (/^pom\.xml$/.test(filePath)) return 'POM';

  return 'OTHER';
}

function isExtractable(fileType) {
  return EXTRACTABLE_TYPES.has(fileType);
}

// Source extensions eligible for content classification after the path pass.
const CONTENT_FALLBACK_EXTS = new Set(['.java', '.kt', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.cs', '.go', '.rb', '.php', '.rs', '.vue',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hh', '.hxx']);
const HIGH_CONFIDENCE_CONTENT_TYPES = new Set([
  'CONTROLLER', 'REPOSITORY', 'ENTITY', 'SCHEDULER', 'CONFIG',
  'NODE_CONTROLLER', 'NODE_MODEL',
  'PYTHON_CONTROLLER', 'PYTHON_MODEL',
  'DOTNET_CONTROLLER', 'DOTNET_REPOSITORY',
  'GO_HANDLER',
  'RUBY_CONTROLLER', 'RUBY_MODEL',
  'PHP_CONTROLLER', 'PHP_MODEL',
  'RUST_HANDLER',
  'CPP_HANDLER',
]);

function classificationFamily(fileType) {
  if (/^NODE_/.test(fileType)) return 'NODE';
  if (/^PYTHON_/.test(fileType)) return 'PYTHON';
  if (/^DOTNET_/.test(fileType)) return 'DOTNET';
  if (/^GO_/.test(fileType)) return 'GO';
  if (/^RUBY_/.test(fileType)) return 'RUBY';
  if (/^PHP_/.test(fileType)) return 'PHP';
  if (/^RUST_/.test(fileType)) return 'RUST';
  if (/^CPP_/.test(fileType)) return 'CPP';
  if (['CONTROLLER', 'SERVICE', 'REPOSITORY', 'ENTITY', 'SCHEDULER', 'CONFIG', 'CONSTANTS'].includes(fileType)) return 'JAVA';
  return fileType;
}

function shouldPreferContentClassification(pathType, contentType) {
  return pathType !== 'OTHER'
    && pathType !== contentType
    && HIGH_CONFIDENCE_CONTENT_TYPES.has(contentType)
    && classificationFamily(pathType) === classificationFamily(contentType);
}

function isContentClassifiable(filePath) {
  const m = /\.[a-z]+$/i.exec(filePath);
  return m ? CONTENT_FALLBACK_EXTS.has(m[0].toLowerCase()) : false;
}

// Content-aware classification — fills OTHER and can correct high-confidence same-stack roles.
// Real-world repos rarely follow strict directory conventions, so we look at framework
// annotations / declarations in the file body to assign a role. Returns a file type or null.
function classifyByContent(filePath, content, stack) {
  if (!content) return null;
  // Drop the leading licence banner before taking the window. Every check below reads the first
  // 8000 characters, and an Apache/GPL header is 700-1500 characters of pure noise at the top of
  // every file in a large OSS repo — on a longer file that is enough to push the only
  // classifying evidence out of the window. Only the banner at the very top is removed, so
  // interior comments (which some checks legitimately read) are untouched.
  const body = content.replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*|#[^\n]*\n\s*)+/, '');
  const head = body.slice(0, 8000);

  if (/\.(?:java|kt)$/i.test(filePath)) {
    if (/@RestController\b|@Controller\b/.test(head)) return 'CONTROLLER';
    if (/@Repository\b|interface\s+\w+\s+extends\s+[\w.]*(?:Repository|Dao)\b|extends\s+(?:Jpa|Crud|PagingAndSorting|Reactive|MongoRepository|R2dbc)\w*Repository\b/.test(head)) return 'REPOSITORY';
    if (/@Service\b/.test(head)) return 'SERVICE';
    if (/@Entity\b|@MappedSuperclass\b|@Embeddable\b|@Document\b|@Table\b|@XmlRootElement\b|@XmlType\b/.test(head)) return 'ENTITY';
    if (/@Scheduled\b|@EnableScheduling\b/.test(head)) return 'SCHEDULER';
    // @Component is Spring's GENERIC stereotype — a plain managed bean, not framework
    // configuration. Listing it here rewrote annotated services into CONFIG, and CONFIG is
    // on the high-confidence override list (Odyssey II Cycle 9). Dropped rather than moved:
    // the checks below already route @Component classes correctly — a Filter/Interceptor to
    // CONFIG, everything else to the SERVICE catch-all — and moving it above @Scheduled
    // would have mislabelled the very common @Component + @Scheduled job class.
    if (/@Configuration\b|@SpringBootApplication\b/.test(head)) return 'CONFIG';
    if (/\bimplements\s+[\w.,\s]*(?:RuntimeHintsRegistrar|WebMvcConfigurer|ApplicationRunner|CommandLineRunner|InitializingBean|DisposableBean|HandlerInterceptor|Filter)\b/.test(head)) return 'CONFIG';
    // Catch-all: any class/interface/enum in the main source tree is worth extracting.
    if (/\b(?:class|interface|enum)\s+\w+/.test(head)) return 'SERVICE';
    return null;
  }

  if (/\.(?:js|jsx|ts|tsx|mjs|cjs)$/i.test(filePath)) {
    if (/express\.Router\s*\(|\brouter\.(?:get|post|put|patch|delete)\s*\(|@(?:Controller|Get|Post|Put|Patch|Delete)Mapping?\(|@Controller\b/.test(head)) return 'NODE_CONTROLLER';
    // NODE_MODEL evidence must DECLARE persisted shape, never merely open a connection.
    // `PrismaClient`/`drizzle(`/`new DataSource(`/`createConnection(` are connection
    // constructors: identical in a service, a controller, a socket wrapper and an AMQP
    // client, so they rewrote every service-path file that touches a database into a model
    // (Odyssey II Cycle 9 — 8 false NODE_MODEL on a 13-file corpus). The declaration-grade
    // Drizzle/TypeORM forms below are what those patterns were reaching for.
    if (/(?:mongoose|Schema)\s*\.\s*(?:model|Schema)\b|new\s+Schema\s*\(|sequelize\.define\s*\(|@Entity\b|new\s+EntitySchema\s*\(|\b(?:pg|mysql|sqlite)Table\s*\(/.test(head)) return 'NODE_MODEL';
    if (/module\.exports\s*=|export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\b/.test(head)) return 'NODE_SERVICE';
    if (/\b(?:class|function)\s+[A-Za-z_$][\w$]*\b/.test(head)) return 'NODE_SERVICE';
    // CommonJS named exports and function expressions. The checks above only recognise
    // `module.exports =`, ESM `export`, and the `function foo`/`class Foo` declaration forms —
    // so a library written in the dominant pre-ESM idiom (`exports.readByte = function ...`,
    // `var send = function ...`) matched nothing and was classified OTHER, which is not
    // extractable. That is most of npm, and it silently dropped the entire Node implementation
    // of apache/thrift (lib/nodejs/lib/thrift/{binary,connection,protocol,transport,index}.js)
    // out of the graph with no error.
    // `exports.foo =` and the re-export barrel form `module.exports.Foo = require('./foo')`.
    // The barrel is worth classifying, not skipping: it declares a package's public API surface
    // and is what resolveReExportEdges needs to resolve `require('thrift').TBinaryProtocol` back
    // to the module that actually defines it.
    if (/(?:^|\n)\s*(?:module\.)?exports\.[A-Za-z_$][\w$]*\s*=/.test(head)) return 'NODE_SERVICE';
    // The ESM barrel, same shape one module system over: `export { a, b as c }` and
    // `export default <expr>`. The check above only matches `export default function|class|const`,
    // so a re-export module matched nothing — half of jquery's source (108 of 224 files) was
    // unclassified on this and the CommonJS forms together.
    if (/(?:^|\n)\s*export\s*\{|(?:^|\n)\s*export\s+default\b|(?:^|\n)\s*export\s+\*/.test(head)) return 'NODE_SERVICE';
    if (/\b(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(head)) return 'NODE_SERVICE';
    // A type-only TS module (only `export type X = ...`, `interface`, `namespace`,
    // `enum` — no runtime class/function) matched nothing above and fell through to
    // OTHER, losing every type declaration it holds (zod's typeAliases.ts, enumUtil.ts).
    // Its type/interface declarations are real graph nodes.
    if (/\.(?:ts|tsx|mts|cts)$/i.test(filePath)
        && /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:type\s+[A-Za-z_$]|interface\s+[A-Za-z_$]|namespace\s+[A-Za-z_$]|enum\s+[A-Za-z_$])/.test(head)) return 'NODE_SERVICE';
    return null;
  }

  if (/\.py$/i.test(filePath)) {
    if (/@(?:app|router)\.(?:get|post|put|patch|delete|route)\b|APIRouter\s*\(|Blueprint\s*\(/.test(head)) return 'PYTHON_CONTROLLER';
    if (/class\s+\w+\s*\([^)]*(?:BaseModel|Base|models\.Model|db\.Model)\b/.test(head)) return 'PYTHON_MODEL';
    if (/^\s*(?:async\s+)?def\s+\w+|^\s*class\s+\w+/m.test(head)) return 'PYTHON_SERVICE';
    // A module with only top-level assignments and no def/class — a __version__.py,
    // a constants.py, a settings module — matched nothing above and fell through to
    // the constant-blind generic path, losing every module constant it holds (10 of
    // requests' lost constants were __version__.py alone). A module-level assignment
    // (optionally annotated) makes it extractable; the bespoke extractor emits its
    // CONSTANT nodes. `=(?!=)` excludes comparisons.
    if (/^[A-Za-z_]\w*\s*(?::[^=\n]+)?=(?!=)/m.test(head)) return 'PYTHON_SERVICE';
    return null;
  }

  if (/\.cs$/i.test(filePath)) {
    if (/\[ApiController\]|:\s*Controller(?:Base)?\b|\[Route\(/.test(head)) return 'DOTNET_CONTROLLER';
    if (/interface\s+I\w+Repository\b|class\s+\w+Repository\b/.test(head)) return 'DOTNET_REPOSITORY';
    return 'DOTNET_SERVICE';
  }

  if (/\.go$/i.test(filePath)) {
    if (/func\s+\w+\s*\(\w+\s+\*?(?:gin\.Context|echo\.Context|http\.ResponseWriter|fiber\.Ctx)\b/.test(head)) return 'GO_HANDLER';
    if (/type\s+\w+\s+struct\s*\{/.test(head)) return 'GO_MODEL';
    return 'GO_SERVICE';
  }

  if (/\.rb$/i.test(filePath)) {
    if (/class\s+\w+Controller\s*</.test(head)) return 'RUBY_CONTROLLER';
    if (/class\s+\w+\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)\b/.test(head)) return 'RUBY_MODEL';
    return 'RUBY_SERVICE';
  }

  if (/\.php$/i.test(filePath)) {
    if (/class\s+\w+Controller\b/.test(head)) return 'PHP_CONTROLLER';
    if (/class\s+\w+\s+extends\s+(?:Model|Eloquent)\b/.test(head)) return 'PHP_MODEL';
    return 'PHP_SERVICE';
  }

  if (/\.rs$/i.test(filePath)) {
    if (/#\[(?:get|post|put|delete|patch|route)\(|HttpServer::new\b/.test(head)) return 'RUST_HANDLER';
    if (/struct\s+\w+/.test(head)) return 'RUST_MODEL';
    return 'RUST_SERVICE';
  }

  // C / C++. Dispatching on extension rather than on `stack` is what makes this work on a
  // polyglot repository: a mixed tree resolves to ONE stack (apache/thrift detects BACKEND from
  // its pom.xml), so CPP_RULES would never be consulted for a .cpp file there. Go, PHP and Ruby
  // already reach 100% classification on thrift for exactly this reason — the content pass keys
  // off the extension and ignores the repository's nominal stack. C/C++ was the one grammar the
  // extractor supported that had no content branch here, which is why it read 0 of 491.
  if (/\.(?:c|cc|cpp|cxx|h|hpp|hh|hxx)$/i.test(filePath)) {
    if (/\b(?:HTTP_HANDLER|handle_request|register_handler)\b|\bhttp_server\b/i.test(head)) return 'CPP_HANDLER';
    // A header whose only declarations are data shapes is a model; anything with a function
    // definition is service code. `struct`/`class` alone is not enough — in C++ that is most of
    // the language — so require the absence of a definition body to call it a model.
    if (/\b(?:struct|class|enum|union)\s+\w+/.test(head) && !/\)\s*(?:const\s*)?(?:noexcept\s*)?\{/.test(head)) return 'CPP_MODEL';
    return 'CPP_SERVICE';
  }

  if (/\.vue$/i.test(filePath)) {
    return 'VUE_COMPONENT';
  }

  return null;
}

// Auto-detect repo type from the file tree (used when the user doesn't specify a stack).
// Detection is by marker files / build manifests — NOT by guessing. Returns null when no
// recognised stack marker is present so the caller can fail loud instead of defaulting to Java.
const NON_DEFINING_DIR = /(?:^|\/)(?:examples?|samples?|demos?|tests?|__tests__|docs?|website|fixtures?|benchmarks?|playground)\//i;

function detectRepoType(filePaths) {
  const allPaths = filePaths.map(f => f.path || f);

  // Marker precedence below is a fixed order, first match wins, with no regard for where the
  // marker sits. On a large polyglot repository that lets one file in one subdirectory speak for
  // the whole tree: apache/thrift was misdetected off a single nested build manifest, ahead of
  // its root-level package.json, go.mod and CMakeLists.txt, its pom.xml, and 6 Cargo.toml.
  //
  // A build manifest at the repository ROOT declares what the repository is; one nested five
  // levels down describes a sub-component. So run the ordered checks against root-level markers
  // first and only fall back to the whole tree when the root says nothing. Single-stack repos
  // are unaffected — their marker is at the root already.
  const rootPaths = allPaths.filter(p => !p.includes('/'));
  return detectFrom(rootPaths, allPaths) || detectFrom(allPaths, allPaths);
}

// markerPaths decides WHICH markers count; evidencePaths is always the whole tree, because the
// tie-breaks inside a branch (.kt vs .java, React vs Vue vs Angular) count source files and those
// never live at the root.
function detectFrom(markerPaths, evidencePaths) {
  const has = re => markerPaths.some(p => re.test(p));
  const paths = evidencePaths;
  // Bundled sample apps, fixtures and docs sites are not what a repository IS. They are excluded
  // from framework discrimination, but fall back to the whole tree when a repo is nothing but
  // examples (so a pure sample project still resolves).
  const primary = evidencePaths.filter(p => !NON_DEFINING_DIR.test(p));
  const discriminationPaths = primary.length ? primary : evidencePaths;
  const hasPrimary = re => discriminationPaths.some(p => re.test(p));

  if (has(/(?:^|\/)pom\.xml$/) || has(/(?:^|\/)build\.gradle(?:\.kts)?$/)) {
    const ktFiles = paths.filter(p => p.endsWith('.kt')).length;
    const javaFiles = paths.filter(p => p.endsWith('.java')).length;
    return (ktFiles > javaFiles) ? 'KOTLIN' : 'BACKEND';
  }
  if (has(/(?:^|\/)[^/]+\.csproj$/) || has(/(?:^|\/)[^/]+\.sln$/)) return 'DOTNET';
  // Swift and Scala sit here, ahead of Gemfile and the CMake fallback, because their real
  // repositories carry those files incidentally: Alamofire has a root Gemfile for its tooling and
  // detected as RUBY, and apple/swift-argument-parser has a CMakeLists.txt and detected as CPP.
  // typelevel/cats and scalatest matched no marker at all, so `koragraph ingest` ABORTED on them
  // with "could not auto-detect a supported stack" — perfect extraction is unreachable behind a
  // repo the walker refuses to open.
  if (has(/(?:^|\/)Package\.swift$/) || has(/(?:^|\/)[^/]+\.podspec$/) || has(/(?:^|\/)[^/]+\.xcodeproj$/)) return 'SWIFT';
  if (has(/(?:^|\/)build\.sbt$/) || has(/(?:^|\/)build\.sc$/)) return 'SCALA';
  if (has(/(?:^|\/)requirements\.txt$/) || has(/(?:^|\/)pyproject\.toml$/) || has(/(?:^|\/)setup\.py$/) || has(/(?:^|\/)Pipfile$/)) return 'PYTHON';
  if (has(/(?:^|\/)go\.mod$/)) return 'GO';
  if (has(/(?:^|\/)Cargo\.toml$/)) return 'RUST';
  if (has(/(?:^|\/)Gemfile$/)) return 'RUBY';
  if (has(/(?:^|\/)composer\.json$/)) return 'PHP';
  if (has(/(?:^|\/)angular\.json$/)) return 'ANGULAR';
  // Node/Vue ecosystem — distinguish framework before generic Node fallback.
  if (has(/(?:^|\/)package\.json$/)) {
    // Framework discrimination is evidence, not a marker: App.jsx / *.vue / *.component.ts are
    // source files and never sit at the repository root, so these read the tree — but a sample
    // app bundled with a library is not what the library IS. Measured on trpc: one
    // examples/nuxt/app.vue and one examples/nuxt/nuxt.config.ts against 739 .ts files detected
    // the whole repository as VUE.
    if (hasPrimary(/src\/.*\.component\.ts$/)) return 'ANGULAR';
    if (hasPrimary(/(?:^|\/)(?:vue|nuxt)\.config\.[jt]s$/) || hasPrimary(/[^/]+\.vue$/)) return 'VUE';
    if (hasPrimary(/^src\/App\.(?:jsx?|tsx?)$/) || hasPrimary(/src\/.*\.(?:jsx|tsx)$/) || hasPrimary(/src\/components?\//)) return 'REACT';
    return 'NODE';
  }
  // C / C++ build markers. Last among the marker checks on purpose: CMakeLists.txt and
  // Makefile.am appear inside plenty of repos that are principally another language (a native
  // addon, a JNI shim), so every language with its own manifest gets to claim the repo first.
  // Without this, a pure C/C++ repository returned null and the ingest aborted with "Could not
  // auto-detect a supported stack" — measured on jsoncpp: 98 files scanned, 0 extracted.
  if (has(/(?:^|\/)CMakeLists\.txt$/) || has(/(?:^|\/)configure\.ac$/)
      || has(/(?:^|\/)Makefile\.am$/) || has(/(?:^|\/)meson\.build$/)
      || has(/(?:^|\/)[^/]+\.vcxproj$/)) return 'CPP';

  // No recognised marker — let the caller decide how to fail.
  return null;
}

module.exports = {
  classify,
  classifyByContent,
  shouldPreferContentClassification,
  isContentClassifiable,
  isExtractable,
  detectRepoType,
  EXTRACTABLE_TYPES,
};
