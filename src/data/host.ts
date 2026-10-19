import { getContext } from '@microsoft/managed-apps/app';
import { getUser } from '@microsoft/managed-apps/auth';

export interface HostContext {
  app: { appId: string; environmentId: string };
  user: { fullName?: string; objectId?: string };
}

/**
 * The app and the signed-in user, as reported by the managed app host.
 *
 * The user carries an Entra object ID rather than a user principal name, so look users up in
 * Dataverse by `azureactivedirectoryobjectid`.
 */
export async function getHostContext(): Promise<HostContext> {
  const [context, user] = await Promise.all([getContext(), getUser().catch(() => undefined)]);
  return {
    app: { appId: context.app.appId, environmentId: context.app.environmentId },
    user: { fullName: user?.fullName || undefined, objectId: user?.objectId || undefined },
  };
}
