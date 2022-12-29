import bs58 from "bs58";
import { Buffer } from "buffer";
import { Layout } from "buffer-layout";
import camelCase from "camelcase";
import { snakeCase } from "snake-case";
import { sha256 } from "js-sha256";
import * as borsh from "@coral-xyz/borsh";
import { AccountMeta, PublicKey } from "@solana/web3.js";
import {
  Idl,
  IdlField,
  IdlType,
  IdlTypeDef,
  IdlAccount,
  IdlAccountItem,
  IdlTypeDefTyStruct,
  IdlTypeVec,
  IdlTypeOption,
  IdlTypeDefined,
  IdlAccounts,
} from "../../idl.js";
import { IdlCoder } from "./idl.js";
import { InstructionCoder } from "../index.js";

/**
 * Namespace for global instruction function signatures (i.e. functions
 * that aren't namespaced by the state or any of its trait implementations).
 */
export const SIGHASH_GLOBAL_NAMESPACE = "global";

/**
 * Encodes and decodes program instructions.
 */
export class BorshInstructionCoder implements InstructionCoder {
  // Instruction args layout. Maps namespaced method
  private ixLayout: Map<string, Layout>;

  // Base58 encoded sighash to instruction layout.
  private discriminatorLayouts: Map<string, { layout: Layout; name: string }>;
  private ixDiscriminator: Map<string, Buffer>;
  private discriminatorLength: number;

  public constructor(private idl: Idl) {
    this.ixLayout = BorshInstructionCoder.parseIxLayout(idl);

    const discriminatorLayouts = new Map();
    const ixDiscriminator = new Map();
    idl.instructions.forEach((ix) => {
      let discriminatorLength: number;
      if (ix.discriminant) {
        discriminatorLayouts.set(
          bs58.encode(Buffer.from(ix.discriminant.value)),
          {
            layout: this.ixLayout.get(ix.name),
            name: ix.name,
          }
        );
        ixDiscriminator.set(ix.name, Buffer.from(ix.discriminant.value));
        discriminatorLength = ix.discriminant.value.length;
      } else {
        const sh = sighash(SIGHASH_GLOBAL_NAMESPACE, ix.name);
        discriminatorLayouts.set(bs58.encode(sh), {
          layout: this.ixLayout.get(ix.name),
          name: ix.name,
        });
        ixDiscriminator.set(ix.name, sh);
        discriminatorLength = 8;
      }
      if (
        this.discriminatorLength &&
        this.discriminatorLength != discriminatorLength
      ) {
        throw new Error(
          `All instructions must have the same discriminator length`
        );
      } else {
        this.discriminatorLength = discriminatorLength;
      }
    });

    this.discriminatorLayouts = discriminatorLayouts;
    this.ixDiscriminator = ixDiscriminator;
  }

  /**
   * Encodes a program instruction.
   */
  public encode(ixName: string, ix: any): Buffer {
    return this._encode(SIGHASH_GLOBAL_NAMESPACE, ixName, ix);
  }

  private _encode(nameSpace: string, ixName: string, ix: any): Buffer {
    const buffer = Buffer.alloc(1000); // TODO: use a tighter buffer.
    const methodName = camelCase(ixName);
    const layout = this.ixLayout.get(methodName);
    const discriminator = this.ixDiscriminator.get(methodName);
    if (!layout || !discriminator) {
      throw new Error(`Unknown method: ${methodName}`);
    }
    const len = layout.encode(ix, buffer);
    const data = buffer.subarray(0, len);
    return Buffer.concat([discriminator, data]);
  }

  private static parseIxLayout(idl: Idl): Map<string, Layout> {
    const ixLayouts = idl.instructions.map((ix): [string, Layout<unknown>] => {
      let fieldLayouts = ix.args.map((arg: IdlField) =>
        IdlCoder.fieldLayout(
          arg,
          Array.from([...(idl.accounts ?? []), ...(idl.types ?? [])])
        )
      );
      const name = camelCase(ix.name);
      return [name, borsh.struct(fieldLayouts, name)];
    });

    return new Map(ixLayouts);
  }

  /**
   * Decodes a program instruction.
   */
  public decode(
    ix: Buffer | string,
    encoding: "hex" | "base58" = "hex"
  ): Instruction | null {
    if (typeof ix === "string") {
      ix = encoding === "hex" ? Buffer.from(ix, "hex") : bs58.decode(ix);
    }
    let sighash = bs58.encode(ix.subarray(0, this.discriminatorLength));
    let data = ix.subarray(this.discriminatorLength);
    const decoder = this.discriminatorLayouts.get(sighash);
    if (!decoder) {
      return null;
    }
    return {
      data: decoder.layout.decode(data),
      name: decoder.name,
    };
  }

  /**
   * Returns a formatted table of all the fields in the given instruction data.
   */
  public format(
    ix: Instruction,
    accountMetas: AccountMeta[]
  ): InstructionDisplay | null {
    return InstructionFormatter.format(ix, accountMetas, this.idl);
  }
}

export type Instruction = {
  name: string;
  data: Object;
};

export type InstructionDisplay = {
  args: { name: string; type: string; data: string }[];
  accounts: {
    name?: string;
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[];
};

class InstructionFormatter {
  public static format(
    ix: Instruction,
    accountMetas: AccountMeta[],
    idl: Idl
  ): InstructionDisplay | null {
    const idlIx = idl.instructions.filter((i) => ix.name === i.name)[0];
    if (idlIx === undefined) {
      console.error("Invalid instruction given");
      return null;
    }

    const args = idlIx.args.map((idlField) => {
      return {
        name: idlField.name,
        type: InstructionFormatter.formatIdlType(idlField.type),
        data: InstructionFormatter.formatIdlData(
          idlField,
          ix.data[idlField.name],
          idl.types
        ),
      };
    });

    const flatIdlAccounts = InstructionFormatter.flattenIdlAccounts(
      idlIx.accounts
    );

    const accounts = accountMetas.map((meta, idx) => {
      if (idx < flatIdlAccounts.length) {
        return {
          name: flatIdlAccounts[idx].name,
          ...meta,
        };
      }
      // "Remaining accounts" are unnamed in Anchor.
      else {
        return {
          name: undefined,
          ...meta,
        };
      }
    });

    return {
      args,
      accounts,
    };
  }

  private static formatIdlType(idlType: IdlType): string {
    if (typeof idlType === "string") {
      return idlType as string;
    }

    if ("vec" in idlType) {
      return `Vec<${this.formatIdlType(idlType.vec)}>`;
    }
    if ("option" in idlType) {
      return `Option<${this.formatIdlType(idlType.option)}>`;
    }
    if ("defined" in idlType) {
      return idlType.defined;
    }
    if ("array" in idlType) {
      return `Array<${idlType.array[0]}; ${idlType.array[1]}>`;
    }

    throw new Error(`Unknown IDL type: ${idlType}`);
  }

  private static formatIdlData(
    idlField: IdlField,
    data: Object,
    types?: IdlTypeDef[]
  ): string {
    if (typeof idlField.type === "string") {
      return data.toString();
    }
    if (idlField.type.hasOwnProperty("vec")) {
      return (
        "[" +
        (<Array<IdlField>>data)
          .map((d: IdlField) =>
            this.formatIdlData(
              { name: "", type: (<IdlTypeVec>idlField.type).vec },
              d
            )
          )
          .join(", ") +
        "]"
      );
    }
    if (idlField.type.hasOwnProperty("option")) {
      return data === null
        ? "null"
        : this.formatIdlData(
            { name: "", type: (<IdlTypeOption>idlField.type).option },
            data,
            types
          );
    }
    if (idlField.type.hasOwnProperty("defined")) {
      if (types === undefined) {
        throw new Error("User defined types not provided");
      }
      const filtered = types.filter(
        (t) => t.name === (<IdlTypeDefined>idlField.type).defined
      );
      if (filtered.length !== 1) {
        throw new Error(
          `Type not found: ${(<IdlTypeDefined>idlField.type).defined}`
        );
      }
      return InstructionFormatter.formatIdlDataDefined(
        filtered[0],
        data,
        types
      );
    }

    return "unknown";
  }

  private static formatIdlDataDefined(
    typeDef: IdlTypeDef,
    data: Object,
    types: IdlTypeDef[]
  ): string {
    if (typeDef.type.kind === "struct") {
      const struct: IdlTypeDefTyStruct = typeDef.type;
      const fields = Object.keys(data)
        .map((k) => {
          const f = struct.fields.filter((f) => f.name === k)[0];
          if (f === undefined) {
            throw new Error("Unable to find type");
          }
          return (
            k + ": " + InstructionFormatter.formatIdlData(f, data[k], types)
          );
        })
        .join(", ");
      return "{ " + fields + " }";
    } else {
      if (typeDef.type.variants.length === 0) {
        return "{}";
      }
      // Struct enum.
      if (typeDef.type.variants[0].name) {
        const variants = typeDef.type.variants;
        const variant = Object.keys(data)[0];
        const enumType = data[variant];
        const namedFields = Object.keys(enumType)
          .map((f) => {
            const fieldData = enumType[f];
            const idlField = variants[variant]?.filter(
              (v: IdlField) => v.name === f
            )[0];
            if (idlField === undefined) {
              throw new Error("Unable to find variant");
            }
            return (
              f +
              ": " +
              InstructionFormatter.formatIdlData(idlField, fieldData, types)
            );
          })
          .join(", ");

        const variantName = camelCase(variant, { pascalCase: true });
        if (namedFields.length === 0) {
          return variantName;
        }
        return `${variantName} { ${namedFields} }`;
      }
      // Tuple enum.
      else {
        // TODO.
        return "Tuple formatting not yet implemented";
      }
    }
  }

  private static flattenIdlAccounts(
    accounts: IdlAccountItem[],
    prefix?: string
  ): IdlAccount[] {
    return accounts
      .map((account) => {
        const accName = sentenceCase(account.name);
        if (account.hasOwnProperty("accounts")) {
          const newPrefix = prefix ? `${prefix} > ${accName}` : accName;
          return InstructionFormatter.flattenIdlAccounts(
            (<IdlAccounts>account).accounts,
            newPrefix
          );
        } else {
          return {
            ...(<IdlAccount>account),
            name: prefix ? `${prefix} > ${accName}` : accName,
          };
        }
      })
      .flat();
  }
}

function sentenceCase(field: string): string {
  const result = field.replace(/([A-Z])/g, " $1");
  return result.charAt(0).toUpperCase() + result.slice(1);
}

// Not technically sighash, since we don't include the arguments, as Rust
// doesn't allow function overloading.
function sighash(nameSpace: string, ixName: string): Buffer {
  let name = snakeCase(ixName);
  let preimage = `${nameSpace}:${name}`;
  return Buffer.from(sha256.digest(preimage)).subarray(0, 8);
}
