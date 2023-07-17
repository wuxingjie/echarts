/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/

import {createHashMap, isObject, map, HashMap, isString, isNumber} from 'zrender/src/core/util';
import Model from '../model/Model';
import {
    HierarchyOrdinalRawValue,
    OrdinalNumber,
    OrdinalRawValue
} from '../util/types';

type HierarchyOrdinalRawValueWithIndex = HierarchyOrdinalRawValue & {
    // leaf index
    index?: number;
};

export class Node implements HierarchyOrdinalRawValue {
    children?: Node[];
    parent?: Node;
    readonly level: number;
    readonly value: string | number;
    // all leaf node index
    readonly leafIndex: number = NaN;

    constructor(tree: Tree, rawValue: HierarchyOrdinalRawValueWithIndex, level: number) {
        this.children =
            rawValue.children?.map(c => new Node(tree, c, level + 1));
        this.children?.forEach(c => {
            c.parent = this;
        });
        this.level = level;
        this.value = rawValue.value;
        if (isNumber(rawValue.index)) {
            this.leafIndex = rawValue.index;
        }
        if (this.isLeaf()) {
            tree.leafNodes.push(this);
        }
    }

    isLeaf(): boolean {
        return !this.children || this.children.length === 0;
    }

    accept(visitor: (n: Node) => void, depthFirst = false): void {
        if (depthFirst) {
            if (this.children) {
                this.children.forEach(c => c.accept(visitor, depthFirst));
            }
            visitor(this);
        }
        else {
            visitor(this);
            if (this.children) {
                this.children.forEach(c => c.accept(visitor, depthFirst));
            }
        }
    }

    firstChild(): Node | undefined {
        return this.children && this.children[0];
    }

    // 向下获取第一个子节点,直到叶子节点
    firstLeafChild(): Node | undefined {
        if (this.isLeaf()) {
            return this;
        }
        else {
            return this.firstChild()?.firstLeafChild();
        }
    }

    lastChild(): Node | undefined {
        return this.children && this.children[this.children.length - 1];
    }

    lastLeafChild(): Node | undefined {
        if (this.isLeaf()) {
            return this;
        }
        else {
            return this.lastChild()?.lastLeafChild();
        }
    }

    startExtent(): number {
        if (this.isLeaf()) {
            return this.leafIndex;
        }
        else {
            return this.firstChild()?.startExtent();
        }
    }

    lastExtent(): number {
        if (this.isLeaf()) {
            return this.leafIndex;
        }
        else {
            return this.lastChild()?.lastExtent();
        }
    }

    getExtent(): [number, number] {
        if (!this.children) {
            return [this.leafIndex, this.leafIndex];
        }
        else {
            return [this.startExtent(), this.lastExtent()];
        }
    }

    getMaxDepth(): number {
        if (this.isLeaf()) {
            return this.level;
        }
        else {
            return this.firstChild()?.getMaxDepth();
        }
    }
}

export class Tree {
    private rootNodes: Node[] = [];
    // use map maybe
    public leafNodes: Node[] = [];

    appendChild(value: HierarchyOrdinalRawValueWithIndex): void {
        this.rootNodes.push(new Node(this, value, 0));
    }

    accept(visitor: (n: Node) => void, depthFirst = false): void {
        this.rootNodes.forEach(c => c.accept(visitor, depthFirst));
    }

    getDepth(): number {
        return this.rootNodes[0]?.getMaxDepth() ?? 0;
    }

    getLeafByIndex(index: number): Node | undefined {
        return this.leafNodes[index];
    }

    lastLeafChild(): Node | undefined {
        return this.rootNodes[this.rootNodes.length - 1]?.lastLeafChild();
    }

}

let uidBase = 0;
class OrdinalMeta {

    readonly categories: OrdinalRawValue[];

    readonly hierarchyCategories: Tree;

    private _needCollect: boolean;

    private _deduplication: boolean;

    private _map: HashMap<OrdinalNumber>;

    readonly uid: number;


    constructor(opt: {
        categories?: OrdinalRawValue[],
        needCollect?: boolean,
        deduplication?: boolean,
        hierarchyCategories?: Tree
    }) {
        this.categories = opt.categories || [];
        this.hierarchyCategories = opt.hierarchyCategories;
        this._needCollect = opt.needCollect;
        this._deduplication = opt.deduplication;
        this.uid = ++uidBase;
    }

    static createByAxisModel(axisModel: Model): OrdinalMeta {
        const option = axisModel.option;
        const data = option.data;
        const hierarchyAxis = option.hierarchyAxis;
        const categories = data && map(data, getName);
        let hierarchyCategories: Tree;
        if (hierarchyAxis) {
            const deepest = (categories: HierarchyOrdinalRawValue[]): HierarchyOrdinalRawValue[] => {
                return categories.reduce((list, category) => {
                        if (isObject(category)) {
                            if (!category.children) {
                                list.push(category);
                            }
                            else {
                                list.push(...deepest(category.children));
                            }
                        }
                        else {
                            list.push(category);
                        }
                        return list;
                    },
                    []);
            };
            const deepestRawValue = deepest(data);
            deepestRawValue.forEach((v, i) => {
                (v as HierarchyOrdinalRawValueWithIndex).index = i;
            });
            const hierarchyCategories = new Tree();
            (data as HierarchyOrdinalRawValue[]).forEach(v => hierarchyCategories.appendChild(v));
            return new OrdinalMeta({
                categories: deepestRawValue.map(v => v.value),
                needCollect: !categories,
                // deduplication is default in axis.
                deduplication: option.dedplication !== false,
                hierarchyCategories
            });
        }
        return new OrdinalMeta({
            categories: categories,
            needCollect: !categories,
            // deduplication is default in axis.
            deduplication: option.dedplication !== false,
            hierarchyCategories
        });
    };

    getOrdinal(category: OrdinalRawValue): OrdinalNumber {
        // @ts-ignore
        return this._getOrCreateMap().get(category);
    }

    /**
     * @return The ordinal. If not found, return NaN.
     */
    parseAndCollect(category: OrdinalRawValue | OrdinalNumber): OrdinalNumber {
        let index;
        const needCollect = this._needCollect;

        // The value of category dim can be the index of the given category set.
        // This feature is only supported when !needCollect, because we should
        // consider a common case: a value is 2017, which is a number but is
        // expected to be tread as a category. This case usually happen in dataset,
        // where it happent to be no need of the index feature.
        if (!isString(category) && !needCollect) {
            return category;
        }

        // Optimize for the scenario:
        // category is ['2012-01-01', '2012-01-02', ...], where the input
        // data has been ensured not duplicate and is large data.
        // Notice, if a dataset dimension provide categroies, usually echarts
        // should remove duplication except user tell echarts dont do that
        // (set axis.deduplication = false), because echarts do not know whether
        // the values in the category dimension has duplication (consider the
        // parallel-aqi example)
        if (needCollect && !this._deduplication) {
            index = this.categories.length;
            this.categories[index] = category;
            return index;
        }

        const map = this._getOrCreateMap();
        // @ts-ignore
        index = map.get(category);

        if (index == null) {
            if (needCollect) {
                index = this.categories.length;
                this.categories[index] = category;
                // @ts-ignore
                map.set(category, index);
            }
        else {
                index = NaN;
            }
        }

        return index;
    }

    // Consider big data, do not create map until needed.
    private _getOrCreateMap(): HashMap<OrdinalNumber> {
        return this._map || (
            this._map = createHashMap<OrdinalNumber>(this.categories)
        );
    }
}

function getName(obj: any): OrdinalRawValue {
    if (isObject(obj) && obj.value) {
        return obj.value;
    }
    else {
        return obj + '';
    }
}

export default OrdinalMeta;
