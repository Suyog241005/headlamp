/*
 * Copyright 2025 The Kubernetes Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { isConditionTrue } from './conditions';
import type { KubeObjectInterface } from './KubeObject';
import { KubeObject } from './KubeObject';
import type { WorkloadHealthCategory } from './Workload';

/**
 * Label the disaggregated set controller stamps on every leader worker set and
 * pod it creates for a disaggregated set, set to the set's name. Child names
 * carry a revision hash, so the label is the stable way to find them.
 */
export const DISAGGREGATED_SET_NAME_LABEL = 'disaggregatedset.x-k8s.io/name';

export interface KubeDisaggregatedRole {
  name: string;
  /** Set on a partitioned role, whose target is the sum of its sub-roles'. */
  subRoles?: { name: string; [otherProps: string]: any }[];
  scaling?: { mode?: 'Static' | 'External' };
  /** Spec of the leader worker set this role runs in every slice. */
  spec?: {
    replicas?: number;
    [otherProps: string]: any;
  };
  [otherProps: string]: any;
}

export interface KubeDisaggregatedRoleStatus {
  name: string;
  /**
   * Replicas the controller drives the role toward, across slices. Controllers
   * before lws v1.0.0 don't report it, and newer ones leave it unset while the
   * target is unknown, e.g. before an external scaler exists.
   */
  desiredReplicas?: number;
  /** Replicas of any revision. */
  replicas?: number;
  readyReplicas?: number;
  /** Replicas of the current revision. */
  updatedReplicas?: number;
  [otherProps: string]: any;
}

export interface KubeDisaggregatedSet extends KubeObjectInterface {
  spec: {
    roles: KubeDisaggregatedRole[];
    slices?: number;
    [otherProps: string]: any;
  };
  status?: {
    observedGeneration?: number;
    roleStatuses?: KubeDisaggregatedRoleStatus[];
    conditions?: {
      type: string;
      status: string;
      [otherProps: string]: any;
    }[];
    [otherProps: string]: any;
  };
}

/** A role's replica counts, totalled across slices. */
export interface DisaggregatedRoleReplicas {
  name: string;
  /** Undefined while the target is unknown. */
  desired?: number;
  ready: number;
  /** Replicas of any revision. */
  replicas: number;
  /** Replicas of the current revision. */
  updated: number;
}

class DisaggregatedSet extends KubeObject<KubeDisaggregatedSet> {
  static kind = 'DisaggregatedSet';
  static apiName = 'disaggregatedsets';
  static apiVersion = 'disaggregatedset.x-k8s.io/v1';
  static isNamespaced = true;

  get spec() {
    return this.jsonData.spec;
  }

  get status() {
    return this.jsonData.status;
  }

  /** Number of copies of the whole role topology, which the CRD defaults to 1. */
  getSlices(): number {
    return this.spec?.slices ?? 1;
  }

  /**
   * Replica counts of each role, in spec order. The target is the one the
   * controller reports. Controllers before lws v1.0.0 don't report one, so
   * for a statically scaled role without sub-roles it is the role's replicas,
   * which the leader worker set CRD defaults to 1, in every slice. Otherwise
   * it stays unknown.
   */
  getRoleReplicas(): DisaggregatedRoleReplicas[] {
    const roleStatuses = this.status?.roleStatuses ?? [];

    return (this.spec?.roles ?? []).map(role => {
      const roleStatus = roleStatuses.find(status => status.name === role.name);
      const fromSpec = role.scaling?.mode !== 'External' && !role.subRoles?.length;

      return {
        name: role.name,
        desired:
          roleStatus?.desiredReplicas ??
          (fromSpec ? (role.spec?.replicas ?? 1) * this.getSlices() : undefined),
        ready: roleStatus?.readyReplicas ?? 0,
        replicas: roleStatus?.replicas ?? 0,
        updated: roleStatus?.updatedReplicas ?? 0,
      };
    });
  }

  /** Target replicas of all roles, or undefined while any role's is unknown. */
  getDesiredReplicas(): number | undefined {
    let total = 0;
    for (const { desired } of this.getRoleReplicas()) {
      if (desired === undefined) {
        return undefined;
      }
      total += desired;
    }
    return total;
  }

  /** Ready replicas of all roles. */
  getReadyReplicas(): number {
    return this.getRoleReplicas().reduce((total, { ready }) => total + ready, 0);
  }

  /**
   * Classifies the disaggregated set into a coarse health category for the
   * Workloads overview chart. A revision only serves with a ready replica of
   * every role, so each role is judged on its own: a surplus in one can't make
   * up for another that is short.
   *
   * The conditions mostly don't help: the controller sets Progressing whenever
   * the set isn't Available, whether it is starting, rolling out or failing.
   */
  getHealth(): WorkloadHealthCategory {
    const observedGeneration = this.status?.observedGeneration;
    const conditions = this.status?.conditions;
    // Not reconciled yet, or the spec changed since.
    if (!observedGeneration || observedGeneration < (this.metadata.generation ?? 0)) {
      return 'transitional';
    }
    // Every role has its target replicas of the current revision, all ready.
    // This also covers controllers before lws v1.0.0, which don't report the
    // target of an externally scaled role.
    if (isConditionTrue(conditions, 'Available')) {
      return 'healthy';
    }
    // An external scaler's name is taken by another object, which only the
    // user can resolve. The controller then stops reconciling the set.
    if (
      conditions?.some(
        condition =>
          condition.type === 'Progressing' && condition.reason === 'ReplicaTargetsUnresolved'
      )
    ) {
      return 'failed';
    }

    const roles = this.getRoleReplicas();
    const known = roles.filter(role => role.desired !== undefined);
    // Replicas of an older revision remain, or a role's groups don't all exist
    // yet: a rollout, the start of a scale-up, or a new role. With surge, every
    // role can be ready while the old replicas are still being replaced.
    if (
      roles.some(role => role.updated < role.replicas) ||
      known.some(role => role.replicas < role.desired!)
    ) {
      return 'transitional';
    }
    const wanted = roles.filter(role => role.desired !== 0);
    // No replica is ready yet. A set whose pods take long to start, as model
    // servers do, can't be told apart from one whose pods fail, so as for a
    // leader worker set, this isn't flagged as a failure.
    if (wanted.length > 0 && wanted.every(role => role.ready === 0)) {
      return 'transitional';
    }
    if (known.some(role => role.ready < role.desired!)) {
      return 'degraded';
    }
    // The targets that are known are met. The others aren't known yet.
    return known.length < roles.length ? 'transitional' : 'healthy';
  }

  static getBaseObject(): KubeDisaggregatedSet {
    const baseObject = super.getBaseObject() as KubeDisaggregatedSet;
    const role = (name: string): KubeDisaggregatedRole => ({
      name,
      spec: {
        replicas: 1,
        leaderWorkerTemplate: {
          size: 1,
          workerTemplate: {
            spec: {
              containers: [{ name: '', image: '', command: [], imagePullPolicy: 'Always' }],
            },
          },
        },
      },
    });
    baseObject.metadata = {
      ...baseObject.metadata,
      namespace: '',
      labels: { app: 'headlamp' },
    };
    baseObject.spec = {
      roles: [role('prefill'), role('decode')],
    };
    return baseObject;
  }
}

export default DisaggregatedSet;
