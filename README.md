# Create the Agent Review Center managed app in your environment

This guide shows you how to create your own copy of the Agent Review Center managed app from the public GitHub repository. You create the app in your own tenant and environment. You don't need a GitHub account, and you don't edit any code.

## Prerequisites

Before you begin, make sure you have:

- The Agent Review Center Power Platform solution installed in your target environment. It includes the tables, flows and AI prompts the app needs.
- A working Microsoft Dataverse connection in that environment.
- [Node.js](https://nodejs.org/) (version 24 or later) and [Git](https://git-scm.com/) installed.
- The Power Platform CLI (`pac`) installed. You need it only to find your connection ID.
- The managed apps CLI installed:

  ```powershell
  npm install -g @microsoft/managed-apps-cli
  ```

- Your environment ID. You can find it in the Power Platform admin center, under **Environments**.

## Step 1: Sign in

```powershell
ms auth login --account <you@yourtenant.com>
```

## Step 2: Create the app from the template

```powershell
ms app create my-arc --template github:powercattools/ARC-ManagedApp-Public -n "Agent Review Center" -e <environment-id> --repo native
```

This command:

- copies the app code from the public repository into the `my-arc` folder
- creates a new managed app in your environment
- creates a Microsoft-hosted Git repository for the app
- writes a new `ms.config.json` file with your app and environment IDs

## Step 3: Push the first commit

```powershell
cd my-arc
git push -u origin HEAD:main
```

A browser window opens. Sign in with the same account you used in step 1.

If the push is rejected, it's because the platform adds its own README commit to the new repository. Rebase onto it and push again:

```powershell
git pull --rebase origin main -X theirs
git push -u origin HEAD:main
```

## Step 4: Find your Dataverse connection ID

```powershell
pac connection list --environment <environment-id>
```

Copy the ID of the connection with the `shared_commondataserviceforapps` connector and the status **Connected**.

## Step 5: Connect the app to Dataverse

```powershell
ms app add data-source --connector commondataserviceforapps --as action --connection-id <connection-id>
```

This creates a connection reference in your environment and points the app at your Dataverse instance.

## Step 6: Build the app

```powershell
npm ci
npm run build
```

Optional: run the app locally to test it before you deploy.

```powershell
ms app dev
```

## Step 7: Commit, push and deploy

```powershell
git add -A
git commit -m "Connect to my environment"
git push
ms app deploy
```

When the deployment finishes, the command shows the app URL. Open it to use the app.

## Troubleshooting

| Problem | Fix |
|---|---|
| `ms app create` fails while fetching the template | The CLI creates the app before it fetches the code. Delete the partial app with `ms app delete --app <app-id> --environment-id <environment-id> --force`, remove the folder, and try again. |
| The push is rejected | Follow the rebase commands in step 3. |
| No browser sign-in appears during the push | Run the push from a normal terminal, not from an automated script. |
| `git status` shows changed files with no real changes | These are line-ending changes. You can commit them or ignore them. |

## Known limitations

- This flow has been tested by an environment admin. First-run behavior for non-admin users isn't confirmed yet.
- Data loss prevention (DLP) policies in your tenant might block the Dataverse connector.
- The managed apps CLI is in preview (version 0.27.0 at the time of writing). Commands might change.
