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

import { describe, expect, it } from 'vitest';
import App from '../../App';
import DisaggregatedSet from './disaggregatedSet';

// cyclic imports fix
// eslint-disable-next-line no-unused-vars
const _dont_delete_me = App;

const makeSet = (spec: any, status?: any) =>
  new DisaggregatedSet({
    apiVersion: 'disaggregatedset.x-k8s.io/v1',
    kind: 'DisaggregatedSet',
    metadata: { name: 'inference', namespace: 'default' },
    spec,
    status,
  } as any);

const staticRoles = [
  { name: 'prefill', spec: { replicas: 2 } },
  { name: 'decode', spec: { replicas: 1 } },
];

/** A role's status. Its replicas default to its target, all of the current revision. */
const roleStatus = (
  name: string,
  desiredReplicas: number | undefined,
  readyReplicas = 0,
  replicas = desiredReplicas ?? 0,
  updatedReplicas = replicas
) => ({ name, desiredReplicas, readyReplicas, replicas, updatedReplicas });

describe('DisaggregatedSet', () => {
  describe('getRoleReplicas', () => {
    it("reads each role's counts from its status, in spec order", () => {
      const set = makeSet(
        { roles: staticRoles },
        { roleStatuses: [roleStatus('decode', 3, 1), roleStatus('prefill', 4, 4, 5, 3)] }
      );
      expect(set.getRoleReplicas()).toEqual([
        { name: 'prefill', desired: 4, ready: 4, replicas: 5, updated: 3 },
        { name: 'decode', desired: 3, ready: 1, replicas: 3, updated: 3 },
      ]);
    });

    it("derives a target an older controller doesn't report from the spec", () => {
      // Each slice runs every role, and the leader worker set CRD defaults
      // replicas to 1.
      const set = makeSet({
        slices: 2,
        roles: [{ name: 'prefill', spec: { replicas: 3 } }, { name: 'decode' }],
      });
      expect(set.getRoleReplicas().map(role => role.desired)).toEqual([6, 2]);
      expect(set.getDesiredReplicas()).toBe(8);
    });

    it('leaves the target of an externally scaled or partitioned role unknown', () => {
      const set = makeSet({
        roles: [
          { name: 'prefill', scaling: { mode: 'External' }, spec: { replicas: 1 } },
          { name: 'decode', subRoles: [{ name: 'a' }], spec: { replicas: 1 } },
        ],
      });
      expect(set.getRoleReplicas().map(role => role.desired)).toEqual([undefined, undefined]);
      expect(set.getDesiredReplicas()).toBeUndefined();
    });
  });

  it('totals the ready replicas of every role', () => {
    const set = makeSet(
      { roles: staticRoles },
      { roleStatuses: [roleStatus('prefill', 2, 2), roleStatus('decode', 1, 1)] }
    );
    expect(set.getReadyReplicas()).toBe(3);
  });

  describe('getHealth', () => {
    const health = (statuses: any[], conditions: any[] = []) =>
      makeSet(
        { roles: staticRoles.map(({ name }) => ({ name, scaling: { mode: 'External' } })) },
        { observedGeneration: 1, roleStatuses: statuses, conditions }
      ).getHealth();

    it('is transitional until the controller has reconciled the set', () => {
      // The targets of statically scaled roles are known from the spec already.
      expect(makeSet({ roles: staticRoles }).getHealth()).toBe('transitional');
    });

    it("is transitional while the controller hasn't seen the latest spec", () => {
      const set = new DisaggregatedSet({
        kind: 'DisaggregatedSet',
        metadata: { name: 'inference', namespace: 'default', generation: 2 },
        spec: { roles: staticRoles },
        status: {
          observedGeneration: 1,
          conditions: [{ type: 'Available', status: 'True' }],
        },
      } as any);
      expect(set.getHealth()).toBe('transitional');
    });

    it('is healthy when the controller reports the set Available', () => {
      // Controllers before lws v1.0.0 report no target for an externally
      // scaled role.
      expect(
        health(
          [
            { name: 'prefill', readyReplicas: 2 },
            { name: 'decode', readyReplicas: 1 },
          ],
          [{ type: 'Available', status: 'True' }]
        )
      ).toBe('healthy');
    });

    it('is transitional while a target is unknown', () => {
      expect(health([roleStatus('prefill', 2, 2), roleStatus('decode', undefined)])).toBe(
        'transitional'
      );
    });

    it('is healthy when every role is ready, including one scaled to zero', () => {
      expect(health([roleStatus('prefill', 2, 2), roleStatus('decode', 0)])).toBe('healthy');
    });

    it('is transitional during a rollout, even when every role is ready', () => {
      // With surge, the new replicas are ready before the old ones are removed.
      expect(health([roleStatus('prefill', 2, 2, 3, 1), roleStatus('decode', 1, 1)])).toBe(
        'transitional'
      );
    });

    it('is transitional while replicas are still being created, e.g. for a new role', () => {
      expect(health([roleStatus('prefill', 2, 2), roleStatus('decode', 1, 0, 0)])).toBe(
        'transitional'
      );
    });

    it('is transitional while no replica is ready yet', () => {
      expect(health([roleStatus('prefill', 2), roleStatus('decode', 1)])).toBe('transitional');
    });

    it("is failed when the controller can't resolve a scaler target", () => {
      expect(
        health(
          [roleStatus('prefill', 2, 2), roleStatus('decode', undefined)],
          [{ type: 'Progressing', status: 'True', reason: 'ReplicaTargetsUnresolved' }]
        )
      ).toBe('failed');
    });

    it('is healthy when every role is scaled to zero, while draining and once drained', () => {
      expect(health([roleStatus('prefill', 0, 2, 2), roleStatus('decode', 0, 1, 1)])).toBe(
        'healthy'
      );
      expect(health([roleStatus('prefill', 0), roleStatus('decode', 0)])).toBe('healthy');
    });

    it('counts a role with an unknown target that has ready replicas as serving', () => {
      expect(health([roleStatus('prefill', 2, 0), roleStatus('decode', undefined, 1, 1)])).toBe(
        'degraded'
      );
    });

    it("doesn't let an unknown target hide a known role that is short", () => {
      expect(health([roleStatus('prefill', 2, 1), roleStatus('decode', undefined, 1, 1)])).toBe(
        'degraded'
      );
    });

    it("is degraded when a role can't serve, even if the others are ready", () => {
      expect(health([roleStatus('prefill', 1, 0), roleStatus('decode', 2, 2)])).toBe('degraded');
    });

    it("doesn't let a surplus in one role make up for another that is short", () => {
      expect(health([roleStatus('prefill', 1, 3), roleStatus('decode', 2, 1)])).toBe('degraded');
    });
  });
});
